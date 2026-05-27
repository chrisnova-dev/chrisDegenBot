import { Context, Markup } from "telegraf";
import { solanaClient } from "../blockchain/connection";
import { globalSettings } from "../services/state"; 
import { sessionState } from "./buy";

export const handleWalletCommand = async (ctx: Context) => {
  const chatId = ctx.chat!.id;
  const loadingMsg = await ctx.reply("⏳ Loading wallet...").catch(() => null);

  try {
    // Explicitly enforce processed commitment to speed up baseline queries
    const balanceLamports = await solanaClient.connection.getBalance(
      solanaClient.wallet.publicKey,
      "processed"
    );
    const balanceSol = balanceLamports / 1e9;

    const text =
      `💳 *WALLET HUB*\n\n` +
      `📦 *Address:*\n\`${solanaClient.wallet.publicKey.toBase58()}\`\n\n` +
      `💰 *Balance:* \`${balanceSol.toFixed(4)} SOL\`\n\n` +
      `🏦 *Withdrawal Address:*\n` +
      `\`${globalSettings.savedWithdrawAddress || "None — set in ⚙️ Trade Settings"}\``;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("💸 Withdraw", "wallet_initiate_withdraw")],
      [Markup.button.callback("🔄 Refresh", "wallet_refresh")],
    ]);

    if (loadingMsg) {
      await ctx.telegram.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    }
    await ctx.reply(text, { parse_mode: "Markdown", ...keyboard });
  } catch (err) {
    if (loadingMsg) {
      await ctx.telegram.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    }
    await ctx.reply("❌ Failed to load wallet. Check your RPC connection.");
  }
};

export const handleWalletCallback = async (ctx: Context, action: string) => {
  const chatId = ctx.chat!.id;

  if (action === "wallet_refresh") {
    await ctx.answerCbQuery("🔄 Refreshing...").catch(() => {});
    await ctx.deleteMessage().catch(() => {});
    return await handleWalletCommand(ctx);
  }

  if (action === "wallet_initiate_withdraw") {
    if (!globalSettings.savedWithdrawAddress) {
      return await ctx.answerCbQuery(
        "🛑 Set a withdrawal address in ⚙️ Trade Settings first!",
        { show_alert: true },
      ).catch(() => {});
    }

    const balanceLamports = await solanaClient.connection.getBalance(
      solanaClient.wallet.publicKey,
      "processed"
    );
    const balanceSol = balanceLamports / 1e9;

    const text =
      `💸 *WITHDRAW*\n\n` +
      `Balance: \`${balanceSol.toFixed(4)} SOL\`\n` +
      `Destination: \`${globalSettings.savedWithdrawAddress}\`\n\n` +
      `Choose amount:`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback("25%", "with_scale_0.25"),
        Markup.button.callback("50%", "with_scale_0.50"),
        Markup.button.callback("75%", "with_scale_0.75"),
      ],
      [
        Markup.button.callback(
          "🔥 MAX (keep 0.005 for fees)",
          "with_scale_1.0",
        ),
      ],
      [Markup.button.callback("✏️ Custom Amount", "with_scale_custom")],
      [Markup.button.callback("◀️ Back", "wallet_refresh")],
    ]);

    await ctx.answerCbQuery().catch(() => {});
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      ...keyboard,
    } as any).catch(() => {});
  }

  if (action.startsWith("with_scale_")) {
    const strategy = action.replace("with_scale_", "");
    const balanceLamports = await solanaClient.connection.getBalance(
      solanaClient.wallet.publicKey,
      "processed"
    );
    const balanceSol = balanceLamports / 1e9;

    if (strategy === "custom") {
      sessionState.set(chatId, {
        ...sessionState.get(chatId),
        pendingWithdrawAmount: true,
      } as any);
      await ctx.answerCbQuery().catch(() => {});
      return await ctx.reply(
        "📥 Enter exact SOL amount to withdraw (e.g., `0.5`):",
      );
    }

    const multiplier = parseFloat(strategy);
    const amount =
      multiplier === 1.0
        ? Math.max(0, balanceSol - 0.005) 
        : balanceSol * multiplier;

    await ctx.answerCbQuery("⚡ Processing...").catch(() => {});
    await ctx.deleteMessage().catch(() => {});
    return await processDirectWithdrawal(ctx, amount);
  }
};

export const processDirectWithdrawal = async (
  ctx: Context,
  amountSol: number,
) => {
  if (amountSol <= 0.001) {
    return await ctx.reply("❌ Amount too small to withdraw.").catch(() => {});
  }

  const chatId = ctx.chat!.id;
  const msg = await ctx.reply(`🚀 Executing high-priority transfer for ${amountSol.toFixed(4)} SOL...`).catch(() => null);

  try {
    const { SystemProgram, Transaction, LAMPORTS_PER_SOL, PublicKey } =
      await import("@solana/web3.js");

    const toPublicKey = new PublicKey(globalSettings.savedWithdrawAddress);
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: solanaClient.wallet.publicKey,
        toPubkey: toPublicKey,
        lamports: Math.floor(amountSol * LAMPORTS_PER_SOL),
      }),
    );

    // FIX: Request explicit processed blockhash state to shield against node request bursts
    const { blockhash } = await solanaClient.connection.getLatestBlockhash("processed");
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = solanaClient.wallet.publicKey;
    
    transaction.sign(solanaClient.wallet);

    // FIX: Enforce fast runtime configurations on the serialized payload transmission
    const txid = await solanaClient.connection.sendRawTransaction(
      transaction.serialize(),
      { 
        skipPreflight: true, // Speeds up private node validation loops significantly
        preflightCommitment: "processed"
      },
    );

    if (msg) {
      await ctx.telegram.deleteMessage(chatId, msg.message_id).catch(() => {});
    }

    await ctx.reply(
      `🟩 *WITHDRAWAL SENT SUCCESSFULLY!*\n\n` +
        `💸 Amount: \`${amountSol.toFixed(4)} SOL\`\n` +
        `🔗 [View on Solscan](https://solscan.io/tx/${txid})`,
      { parse_mode: "Markdown", link_preview_options: { is_disabled: true } },
    ).catch(() => {});
  } catch (err: any) {
    console.error("[WITHDRAW] Critical failure:", err);
    if (msg) {
      await ctx.telegram.deleteMessage(chatId, msg.message_id).catch(() => {});
    }
    await ctx.reply(`🛑 Withdrawal execution dropped: ${err.message || "Network synchronization error"}`).catch(() => {});
  }
};