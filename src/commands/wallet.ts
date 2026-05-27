import { Context, Markup } from "telegraf";
import { solanaClient } from "../blockchain/connection";
import { globalSettings } from "../services/state"; 
import { sessionState } from "./buy";

// Utility helper to force-abort hanging blockchain calls after 5 seconds
const fetchWithTimeout = async <T>(promise: Promise<T>, timeoutMs = 5000): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("RPC network connection timed out")), timeoutMs)
    ),
  ]);
};

export const handleWalletCommand = async (ctx: Context) => {
  const chatId = ctx.chat!.id;
  const loadingMsg = await ctx.reply("⏳ Loading wallet...").catch(() => null);

  try {
    // Wrap the connection request in our timeout helper to prevent hanging loops
    const balanceLamports = await fetchWithTimeout(
      solanaClient.connection.getBalance(solanaClient.wallet.publicKey, "processed"),
      5000
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
  } catch (err: any) {
    console.error("[WALLET] Error fetching balance:", err.message || err);
    if (loadingMsg) {
      await ctx.telegram.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    }
    await ctx.reply(`❌ Wallet balance unavailable: ${err.message || "Connection timeout"}. Check your RPC configuration.`);
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

    const loadingMsg = await ctx.reply("⏳ Reading balance...").catch(() => null);

    try {
      const balanceLamports = await fetchWithTimeout(
        solanaClient.connection.getBalance(solanaClient.wallet.publicKey, "processed"),
        5000
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
      if (loadingMsg) {
        await ctx.telegram.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      }
      await ctx.reply(text, { parse_mode: "Markdown", ...keyboard });
    } catch (err: any) {
      if (loadingMsg) {
        await ctx.telegram.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      }
      return await ctx.answerCbQuery("🛑 RPC Node Busy. Could not read balance.", { show_alert: true }).catch(() => {});
    }
  }

  if (action.startsWith("with_scale_")) {
    const strategy = action.replace("with_scale_", "");
    
    try {
      const balanceLamports = await fetchWithTimeout(
        solanaClient.connection.getBalance(solanaClient.wallet.publicKey, "processed"),
        5000
      );
      const balanceSol = balanceLamports / 1e9;

      if (strategy === "custom") {
        sessionState.set(chatId, {
          ...sessionState.get(chatId),
          pendingWithdrawAmount: true,
        } as any);
        await ctx.answerCbQuery().catch(() => {});
        return await ctx.reply("📥 Enter exact SOL amount to withdraw (e.g., `0.5`):");
      }

      const multiplier = parseFloat(strategy);
      const amount =
        multiplier === 1.0
          ? Math.max(0, balanceSol - 0.005) 
          : balanceSol * multiplier;

      await ctx.answerCbQuery("⚡ Processing...").catch(() => {});
      await ctx.deleteMessage().catch(() => {});
      return await processDirectWithdrawal(ctx, amount);
    } catch (err) {
      return await ctx.answerCbQuery("🛑 Network timeout reading balance. Try again.", { show_alert: true }).catch(() => {});
    }
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

    const { blockhash } = await fetchWithTimeout(
      solanaClient.connection.getLatestBlockhash("processed"),
      5000
    );
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = solanaClient.wallet.publicKey;
    
    transaction.sign(solanaClient.wallet);

    const txid = await fetchWithTimeout(
      solanaClient.connection.sendRawTransaction(
        transaction.serialize(),
        { 
          skipPreflight: true, 
          preflightCommitment: "processed"
        }
      ),
      5000
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