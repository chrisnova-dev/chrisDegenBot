import fetch from "cross-fetch";
import { Telegraf } from "telegraf";
import { PublicKey } from "@solana/web3.js";
import { jupiterService } from "./jupiter";
import { solanaClient } from "../blockchain/connection";
import { Position } from "../types/position";
import { trackedWallets, globalSettings } from "./state";
import { handleContractPaste } from "../commands/buy";
import { CONFIG } from "../config/env";

const JUPITER_PROGRAM = "JUP6L81g9K7E5tN1mCYaJm69f6P586xZ3893F7A";
const RAYDIUM_PROGRAM = "675kPX9M4SG3Nao668Zzd65HC7Wf3pUK1bMM16MR8dV8";
const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const NATIVE_SOL = "So11111111111111111111111111111111111111112";

class PositionMonitor {
  private activePositions: Map<string, Position> = new Map();
  private isLoopRunning = false;

  // One single bot instance and chat ID — set once, used forever
  private bot: Telegraf | null = null;
  private chatId: number | null = null;

  // ─── INIT ────────────────────────────────────────────────────

  // Called at bot.launch() — guaranteed to run before any wallet alert
  public initializeFromStart(bot: Telegraf, chatId: number) {
    this.bot = bot;
    this.chatId = chatId;
    console.log(`✅ [MONITOR] Ready. Alerts → Chat ID: ${chatId}`);
  }

  // Called from ctx handlers (keeps same instance, won't overwrite)
  public initialize(bot: Telegraf, chatId: number) {
    if (!this.bot) this.bot = bot;
    if (!this.chatId) this.chatId = chatId;
  }

  // ─── POSITION TRACKING ───────────────────────────────────────

  public trackPosition(position: Position) {
    this.activePositions.set(position.tokenMint, position);
    console.log(`📈 Now tracking position: ${position.tokenSymbol}`);
    if (!this.isLoopRunning) this.startMonitoringLoop();
  }

  public getPositions(): Position[] {
    return Array.from(this.activePositions.values());
  }

  // ─── WALLET TRACKING ─────────────────────────────────────────

  public async addTrackedWallet(address: string, name: string) {
    try {
      new PublicKey(address); // Validate address first

      const subId = solanaClient.connection.onLogs(
        new PublicKey(address),
        async (logs) => {
          if (logs.err) return;

          const logStr = logs.logs.join(" ");
          const isDex =
            logStr.includes(JUPITER_PROGRAM) ||
            logStr.includes(RAYDIUM_PROGRAM) ||
            logStr.includes(PUMPFUN_PROGRAM);

          if (!isDex) return;

          // 2s delay — let RPC finalize the block before we parse it
          setTimeout(() => this.processTrade(address, logs.signature), 2000);
        },
        "confirmed",
      );

      trackedWallets.set(address, {
        address,
        name,
        subscriptionId: subId,
        isActive: true,
        addedAt: Date.now(),
      });

      console.log(`🎯 Tracking wallet: ${name} (${address})`);
      this.notify(
        `🟩 *Now tracking: ${name}*\n\`${address}\`\n\nYou'll get alerts when they trade.`,
      );
    } catch (err: any) {
      console.error("[MONITOR] addTrackedWallet error:", err);
      this.notify(`❌ Failed to track wallet. Check the address is valid.`);
    }
  }

  private async processTrade(walletAddress: string, signature: string) {
    try {
      const txInfo = await solanaClient.connection.getParsedTransaction(
        signature,
        {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        },
      );

      if (!txInfo?.meta) return;

      const preBalances = txInfo.meta.preTokenBalances || [];
      const postBalances = txInfo.meta.postTokenBalances || [];

      // Find the non-SOL token in the transaction
      let detectedMint = "";
      for (const bal of postBalances) {
        if (bal.mint !== NATIVE_SOL) {
          detectedMint = bal.mint;
          break;
        }
      }
      if (!detectedMint) return;

      // Check if it's a buy or sell by comparing token balance
      const pre = preBalances.find(
        (b) => b.owner === walletAddress && b.mint === detectedMint,
      );
      const post = postBalances.find(
        (b) => b.owner === walletAddress && b.mint === detectedMint,
      );

      const preAmt = pre?.uiTokenAmount.uiAmount ?? 0;
      const postAmt = post?.uiTokenAmount.uiAmount ?? 0;

      if (preAmt === postAmt) return; // No change, skip

      const isBuy = postAmt > preAmt;
      const actionEmoji = isBuy ? "🟢" : "🔴";
      const actionWord = isBuy ? "BOUGHT" : "SOLD";

      const wallet = trackedWallets.get(walletAddress);
      const walletName =
        wallet?.name ||
        `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;

      // Try to get token symbol from DexScreener
      let tokenDisplay = `${detectedMint.slice(0, 8)}...`;
      try {
        const res = await fetch(
          `https://api.dexscreener.com/latest/dex/tokens/${detectedMint}`,
        );
        const dexData = await res.json();
        if (dexData.pairs?.length > 0) {
          tokenDisplay = `$${dexData.pairs[0].baseToken.symbol}`;
        }
      } catch {
        // DexScreener failed, use short address — not a crash
      }

      // Send alert
      this.notify(
        `${actionEmoji} *${walletName} ${actionWord}*\n\n` +
          `🪙 Token: *${tokenDisplay}*\n` +
          `📝 CA: \`${detectedMint}\`\n` +
          `🔗 [Solscan](https://solscan.io/tx/${signature})\n\n` +
          `_Paste the CA to buy instantly_`,
      );

      // If it's a buy — show trade dashboard automatically
      if (isBuy && this.bot && this.chatId) {
        const mockCtx: any = {
          chat: { id: this.chatId },
          telegram: this.bot.telegram,
          reply: (text: string, opts?: any) =>
            this.bot!.telegram.sendMessage(this.chatId!, text, opts),
          replyWithMarkdown: (text: string, extra?: any) =>
            this.bot!.telegram.sendMessage(this.chatId!, text, {
              parse_mode: "Markdown",
              ...extra,
            }),
        };
        await handleContractPaste(mockCtx, detectedMint);
      }
    } catch (err: any) {
      // Log the error but NEVER crash
      console.error("[MONITOR] processTrade error:", err?.message || err);
    }
  }

  public async removeTrackedWallet(address: string) {
    const wallet = trackedWallets.get(address);
    if (!wallet) return;

    if (wallet.subscriptionId !== undefined) {
      await solanaClient.connection
        .removeOnLogsListener(wallet.subscriptionId)
        .catch(() => {});
    }

    trackedWallets.delete(address);
    console.log(`🗑️ Stopped tracking: ${wallet.name}`);
  }

  // ─── POSITION MONITORING LOOP ─────────────────────────────────

  private async startMonitoringLoop() {
    this.isLoopRunning = true;
    console.log("🔄 [MONITOR] Price monitoring loop started");

    while (this.activePositions.size > 0) {
      try {
        const mints = Array.from(this.activePositions.keys());

        const res = await fetch(
          `https://lite-api.jup.ag/price/v2?ids=${mints.join(",")}`,
        );

        if (!res.ok) {
          console.error(`[MONITOR] Price API error: ${res.status}`);
          await new Promise((r) => setTimeout(r, 5000)); // Wait longer on error
          continue;
        }

        const json = await res.json();
        const priceData = json.data || {};

        for (const mint of mints) {
          const position = this.activePositions.get(mint);
          const priceInfo = priceData[mint];
          if (!position || !priceInfo) continue;

          const currentPrice = parseFloat(priceInfo.price);
          if (!currentPrice || isNaN(currentPrice)) continue;

          const multiplier = currentPrice / position.buyPriceUsd;
          const lossPercent =
            (position.buyPriceUsd - currentPrice) / position.buyPriceUsd;

          console.log(
            `⚡ ${position.tokenSymbol} | ` +
              `${multiplier.toFixed(2)}x | ` +
              `${lossPercent > 0 ? "-" : "+"}${Math.abs(lossPercent * 100).toFixed(1)}%`,
          );

          // Take profit check
          if (
            globalSettings.autoSellEnabled &&
            position.takeProfitMultiplier > 0 &&
            multiplier >= position.takeProfitMultiplier
          ) {
            await this.triggerAutoSell(
              position,
              `🎯 Take Profit Hit (${multiplier.toFixed(2)}x)`,
            );
            continue;
          }

          // Stop loss check
          if (
            globalSettings.autoSellEnabled &&
            position.stopLossPercent > 0 &&
            lossPercent >= position.stopLossPercent
          ) {
            await this.triggerAutoSell(
              position,
              `🚨 Stop Loss Hit (-${(position.stopLossPercent * 100).toFixed(0)}%)`,
            );
          }
        }
      } catch (err: any) {
        console.error("[MONITOR] Loop error:", err?.message || err);
      }

      await new Promise((r) => setTimeout(r, 2000));
    }

    this.isLoopRunning = false;
    console.log("⏹️ [MONITOR] Price loop stopped — no active positions");
  }

  private async triggerAutoSell(position: Position, reason: string) {
    // Remove first — prevents double sell if loop runs again fast
    this.activePositions.delete(position.tokenMint);

    this.notify(
      `⚠️ *AUTO SELL TRIGGERED*\n${reason}\n\nSelling $${position.tokenSymbol}...`,
    );

    try {
      // Updated to modern public endpoint patterns
      const url =
        `https://public.jupiterapi.com/quote` +
        `?inputMint=${position.tokenMint}` +
        `&outputMint=${NATIVE_SOL}` +
        `&amount=${Math.floor(position.amountTokens)}` +
        `&slippageBps=300`;

      const res = await fetch(url);
      if (!res.ok) throw new Error(`Sell quote failed: ${res.status}`);

      const sellQuote = await res.json();
      const tx = await jupiterService.buildSwapTransaction(sellQuote);
      tx.sign([solanaClient.wallet]);

      const txid = await solanaClient.connection.sendRawTransaction(
        tx.serialize(),
        { skipPreflight: true, maxRetries: 3 },
      );

      this.notify(
        `🟩 *AUTO SELL COMPLETE*\n\n` +
          `🪙 Token: $${position.tokenSymbol}\n` +
          `📦 Reason: ${reason}\n` +
          `🔗 [Solscan](https://solscan.io/tx/${txid})`,
      );
    } catch (err: any) {
      console.error("[MONITOR] triggerAutoSell error:", err?.message || err);
      this.notify(
        `🛑 *AUTO SELL FAILED*\n` +
          `${err.message || "Unknown error"}\n\n` +
          `⚠️ Sell manually!\nCA: \`${position.tokenMint}\``,
      );
    }
  }

  // ─── SAFE NOTIFY ─────────────────────────────────────────────

  private notify(message: string) {
    // Guard — if somehow not initialized, just log it
    if (!this.bot || !this.chatId) {
      console.log(
        `[MONITOR] Not initialized. Missed alert:\n${message.slice(0, 80)}`,
      );
      return;
    }

    // Direct access to the root telegram context engine safely
    const targetTelegram = (this.bot as any).telegram || this.bot;

    targetTelegram
      .sendMessage(this.chatId, message, {
        parse_mode: "Markdown",
        link_preview_options: { is_disabled: true },
      })
      .catch((err: any) => {
        console.error("[MONITOR] notify failed:", err?.message || err);
      });
  }
}

export const positionMonitor = new PositionMonitor();