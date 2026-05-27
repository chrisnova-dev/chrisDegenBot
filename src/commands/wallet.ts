import { Context, Markup } from "telegraf";
import { solanaClient } from "../blockchain/connection";
import { globalSettings } from "../services/state"; 
import { sessionState } from "./buy";

// Helper to prevent hanging RPC calls
const fetchWithTimeout = async <T>(promise: Promise<T>, timeoutMs = 5000): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("RPC network connection timed out")), timeoutMs)
    ),
  ]);
};

export const handleWalletCommand = async (ctx: Context, isCallback = false) => {
  const chatId = ctx.chat!.id;
  
  // 1. CLEVER UI ROUTING: If called via button click, edit inline instead of spamming a new message
  let loadingMsg: any = null;
  if (!isCallback) {
    loadingMsg = await ctx.reply("⏳ Loading wallet...").catch(() => null);
  } else {
    await ctx.answerCbQuery("🔄 Fetching balance...").catch(() => {});
  }

  try {
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
      [Markup.button.callback("🔄 Refresh Balance", "wallet_refresh")],
    ]);

    if (isCallback) {
      // Clean update: recycles the interface in place
      await ctx.editMessageText(text, { parse_mode: "Markdown", ...keyboard }).catch(() => {});
    } else {
      // Standard text entry: wipes the loading state and posts the interactive panel
      if (loadingMsg) await ctx.telegram.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      await ctx.reply(text, { parse_mode: "Markdown", ...keyboard });
    }
  } catch (err: any) {
    const errorText = `❌ Wallet balance unavailable: ${err.message || "Timeout"}. Check your RPC configuration.`;
    
    if (isCallback) {
      // Change the frame to show error but preserve the button structure to let them retry easily
      await ctx.editMessageText(errorText, Markup.inlineKeyboard([[Markup.button.callback("🔄 Retry Connection", "wallet_refresh")]]));
    } else {
      if (loadingMsg) await ctx.telegram.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      await ctx.reply(errorText);
    }
  }
};

export const handleWalletCallback = async (ctx: Context, action: string) => {
  const chatId = ctx.chat!.id;

  if (action === "wallet_refresh") {
    // Pass true flag to reuse the original message panel frame natively
    return await handleWalletCommand(ctx, true);
  }

  if (action === "wallet_initiate_withdraw") {
    if (!globalSettings.savedWithdrawAddress) {
      return await ctx.answerCbQuery(
        "🛑 Set a withdrawal address in ⚙️ Trade Settings first!",
        { show_alert: true },
      ).catch(() => {});
    }

    await ctx.answerCbQuery("🧮 Calculating limits...").catch(() => {});

    try {
      const balanceLamports = await fetchWithTimeout(
        solanaClient.connection.getBalance(solanaClient.wallet.publicKey, "processed"),
        5000
      );
      const balanceSol = balanceLamports / 1e9;

      const text =
        `💸 *WITHDRAW FUNDS*\n\n` +
        `Available: \`${balanceSol.toFixed(4)} SOL\`\n` +
        `Destination: \`${globalSettings.savedWithdrawAddress}\`\n\n` +
        `Choose composition allocation amount:`;

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback("25%", "with_scale_0.25"),
          Markup.button.callback("50%", "with_scale_0.50"),
          Markup.button.callback("75%", "with_scale_0.75"),
        ],
        [Markup.button.callback("🔥 MAX (keep 0.005 for fees)", "with_scale_1.0")],
        [Markup.button.callback("✏️ Custom Amount", "with_scale_custom")],
        [Markup.button.callback("◀️ Back to Hub", "wallet_refresh")],
      ]);

      // Modifies the current view window directly without outputting new blocks
      await ctx.editMessageText(text, { parse_mode: "Markdown", ...keyboard }).catch(() => {});
    } catch (err: any) {
      return await ctx.answerCbQuery("🛑 Network busy. Couldn't update interface.", { show_alert: true }).catch(() => {});
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
        sessionState.set(chatId, { ...sessionState.get(chatId), pendingWithdrawAmount: true } as any);
        await ctx.answerCbQuery().catch(() => {});
        
        // Stale interface is deleted so user can focus on the manual input step
        await ctx.deleteMessage().catch(() => {});
        return await ctx.reply("📥 Enter exact SOL amount to withdraw (e.g., `0.5`):");
      }

      const multiplier = parseFloat(strategy);
      const amount = multiplier === 1.0 ? Math.max(0, balanceSol - 0.005) : balanceSol * multiplier;

      await ctx.answerCbQuery("⚡ Submitting execution sequence...").catch(() => {});
      await ctx.deleteMessage().catch(() => {});
      return await processDirectWithdrawal(ctx, amount);
    } catch (err) {
      return await ctx.answerCbQuery("🛑 Session Timeout. Please retry.", { show_alert: true }).catch(() => {});
    }
  }
};

export const processDirectWithdrawal = async (ctx: Context, amountSol: number) => {
  if (amountSol <= 0.001) {
    return await ctx.reply("❌ Amount too small to withdraw.").catch(() => {});
  }

  // Fire tracking notice
  const statusMsg = await ctx.reply(`🚀 Broadcasting transfer: ${amountSol.toFixed(4)} SOL...`).catch(() => null);

  try {
    const { SystemProgram, Transaction, LAMPORTS_PER_SOL, PublicKey } = await import("@solana/web3.js");

    const toPublicKey = new PublicKey(globalSettings.savedWithdrawAddress);
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: solanaClient.wallet.publicKey,
        toPubkey: toPublicKey,
        lamports: Math.floor(amountSol * LAMPORTS_PER_SOL),
      }),
    );

    const { blockhash } = await fetchWithTimeout(solanaClient.connection.getLatestBlockhash("processed"), 5000);
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = solanaClient.wallet.publicKey;
    transaction.sign(solanaClient.wallet);

    const txid = await fetchWithTimeout(
      solanaClient.connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, preflightCommitment: "processed" }),
      5000
    );

    // Auto-wipe the temporary loading text before showing the success invoice
    if (statusMsg) await ctx.telegram.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});

    await ctx.reply(
      `🟩 *WITHDRAWAL SENT SUCCESSFULLY!*\n\n` +
      `💸 Amount: \`${amountSol.toFixed(4)} SOL\`\n` +
      `🔗 [View on Solscan](https://solscan.io/tx/${txid})`,
      { parse_mode: "Markdown", link_preview_options: { is_disabled: true } },
    ).catch(() => {});
  } catch (err: any) {
    if (statusMsg) await ctx.telegram.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
    await ctx.reply(`🛑 Execution dropped: ${err.message || "Network Error"}`).catch(() => {});
  }
};