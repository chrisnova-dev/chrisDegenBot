// src/services/monitor.ts
import fetch from 'cross-fetch';
import { Telegraf } from 'telegraf';
import { PublicKey } from '@solana/web3.js';
import { jupiterService } from './jupiter';
import { solanaClient } from '../blockchain/connection';
import { Position } from '../types/position';
import { trackedWallets, globalSettings } from './state';
import { handleContractPaste } from '../commands/buy';
import { CONFIG } from '../config/env'; // Import environment targets

const JUPITER_PROGRAM = 'JUP6L81g9K7E5tN1mCYaJm69f6P586xZ3893F7A';
const RAYDIUM_PROGRAM = '675kPX9M4SG3Nao668Zzd65HC7Wf3pUK1bMM16MR8dV8';
const PUMPFUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const NATIVE_SOL = 'So11111111111111111111111111111111111111112';

class PositionMonitor {
  private activePositions: Map<string, Position> = new Map();
  private isLoopRunning = false;
  private botInstance?: Telegraf;
  private telegramChatId?: number;

  public initialize(bot: Telegraf, chatId: number) {
    this.botInstance = bot;
    this.telegramChatId = chatId;
    console.log(`📡 [MONITOR] Intialized and anchored to Chat ID: ${chatId}`);
  }

  public trackPosition(position: Position) {
    this.activePositions.set(position.tokenMint, position);
    console.log(`📈 Tracking: ${position.tokenSymbol}`);
    if (!this.isLoopRunning) this.startMonitoringLoop();
  }

  public getPositions(): Position[] {
    return Array.from(this.activePositions.values());
  }

  // ─── WALLET TRACKING ─────────────────────────────────────────
  public async addTrackedWallet(address: string, name: string) {
    try {
      const pubkey = new PublicKey(address);

      const subId = solanaClient.connection.onLogs(
        pubkey,
        async (logs) => {
          if (logs.err) return;

          const logStr = logs.logs.join(' ');
          const isDex =
            logStr.includes(JUPITER_PROGRAM) ||
            logStr.includes(RAYDIUM_PROGRAM) ||
            logStr.includes(PUMPFUN_PROGRAM);

          if (!isDex) return;

          // Wait 2s for RPC to finalize transaction block state records
          setTimeout(() => this.processTrade(address, logs.signature), 2000);
        },
        'confirmed'
      );

      trackedWallets.set(address, {
        address,
        name,
        subscriptionId: subId,
        isActive: true,
        addedAt: Date.now(),
      });

      console.log(`🎯 Tracking wallet: ${name} (${address})`);

    } catch (err) {
      console.error('[MONITOR] addTrackedWallet error:', err);
      this.notifyUser(`❌ Failed to start tracking. Check the address.`);
    }
  }

  private async processTrade(walletAddress: string, signature: string) {
    try {
      const txInfo = await solanaClient.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!txInfo?.meta) return;

      const preBalances = txInfo.meta.preTokenBalances || [];
      const postBalances = txInfo.meta.postTokenBalances || [];

      // Find the non-SOL token that was traded
      let detectedMint = '';
      for (const bal of postBalances) {
        if (bal.mint !== NATIVE_SOL) {
          detectedMint = bal.mint;
          break;
        }
      }
      if (!detectedMint) return;

      // Determine BUY or SELL
      const pre = preBalances.find(
        (b) => b.owner === walletAddress && b.mint === detectedMint
      );
      const post = postBalances.find(
        (b) => b.owner === walletAddress && b.mint === detectedMint
      );

      const preAmt = pre?.uiTokenAmount.uiAmount ?? 0;
      const postAmt = post?.uiTokenAmount.uiAmount ?? 0;

      if (preAmt === postAmt) return; // No balance changes, skip

      const isBuy = postAmt > preAmt;
      const actionEmoji = isBuy ? '🟢' : '🔴';
      const actionWord = isBuy ? 'BOUGHT' : 'SOLD';

      const wallet = trackedWallets.get(walletAddress);
      const walletName = wallet?.name || `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;

      // Get token symbol from DexScreener
      let tokenDisplay = `\`${detectedMint.slice(0, 8)}...\``;
      try {
        const res = await fetch(
          `https://api.dexscreener.com/latest/dex/tokens/${detectedMint}`
        );
        const dexData = await res.json();
        if (dexData.pairs?.length > 0) {
          tokenDisplay = `$${dexData.pairs[0].baseToken.symbol}`;
        }
      } catch {}

      this.notifyUser(
        `${actionEmoji} *${walletName} ${actionWord}*\n\n` +
        `🪙 Token: *${tokenDisplay}*\n` +
        `📝 CA: \`${detectedMint}\`\n` +
        `🔗 [Solscan](https://solscan.io/tx/${signature})\n\n` +
        `_Paste the CA below to buy instantly_`
      );

      // If it's a BUY, auto-show the trade dashboard
      if (isBuy) {
        // Resolve target Chat ID using either instance properties or session memory defaults
        const targetChatId = this.telegramChatId || (globalSettings as any).fallbackChatId;
        const activeBot = this.botInstance || new Telegraf(CONFIG.BOT_TOKEN);

        if (targetChatId) {
          const mockCtx: any = {
            chat: { id: targetChatId },
            telegram: activeBot.telegram,
            reply: (text: string, opts?: any) =>
              activeBot.telegram.sendMessage(targetChatId, text, opts),
            replyWithMarkdown: (text: string, extra?: any) =>
              activeBot.telegram.sendMessage(targetChatId, text, {
                parse_mode: 'Markdown',
                ...extra,
              }),
          };
          await handleContractPaste(mockCtx, detectedMint);
        }
      }
    } catch (err) {
      console.error('[MONITOR] processTrade error:', err);
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

    while (this.activePositions.size > 0) {
      try {
        const mints = Array.from(this.activePositions.keys());
        const res = await fetch(
          `https://lite-api.jup.ag/price/v2?ids=${mints.join(',')}`
        );

        if (!res.ok) throw new Error(`Jupiter price API error: ${res.status}`);

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
            `⚡ ${position.tokenSymbol} | ${multiplier.toFixed(2)}x | ` +
            `${lossPercent > 0 ? '-' : '+'}${Math.abs(lossPercent * 100).toFixed(1)}%`
          );

          // Check TP
          if (
            globalSettings.autoSellEnabled &&
            position.takeProfitMultiplier > 0 &&
            multiplier >= position.takeProfitMultiplier
          ) {
            await this.triggerAutoSell(
              position,
              `🎯 Take Profit Hit (${multiplier.toFixed(2)}x)`
            );
            continue;
          }

          // Check SL
          if (
            globalSettings.autoSellEnabled &&
            position.stopLossPercent > 0 &&
            lossPercent >= position.stopLossPercent
          ) {
            await this.triggerAutoSell(
              position,
              `🚨 Stop Loss Hit (-${(position.stopLossPercent * 100).toFixed(0)}%)`
            );
          }
        }
      } catch (err) {
        console.error('[MONITOR] Loop error:', err);
      }

      await new Promise((r) => setTimeout(r, 2000));
    }

    this.isLoopRunning = false;
  }

  private async triggerAutoSell(position: Position, reason: string) {
    this.activePositions.delete(position.tokenMint);

    this.notifyUser(
      `⚠️ *AUTO SELL TRIGGERED*\n${reason}\n\nSelling $${position.tokenSymbol}...`
    );

    try {
      const url =
        `https://api.jup.ag/swap/v1/quote` +
        `?inputMint=${position.tokenMint}` +
        `&outputMint=${NATIVE_SOL}` +
        `&amount=${Math.floor(position.amountTokens)}` +
        `&slippageBps=300`;

      const res = await fetch(url);
      if (!res.ok) throw new Error(`Quote failed: ${res.status}`);
      const sellQuote = await res.json();

      const tx = await jupiterService.buildSwapTransaction(sellQuote);
      tx.sign([solanaClient.wallet]);

      const txid = await solanaClient.connection.sendRawTransaction(
        tx.serialize(),
        { skipPreflight: true, maxRetries: 3 }
      );

      this.notifyUser(
        `🟩 *AUTO SELL COMPLETE*\n\n` +
        `🪙 Token: $${position.tokenSymbol}\n` +
        `📦 Reason: ${reason}\n` +
        `🔗 [Solscan](https://solscan.io/tx/${txid})`
      );
    } catch (err: any) {
      console.error('[MONITOR] triggerAutoSell error:', err);
      this.notifyUser(
        `🛑 *AUTO SELL FAILED*\n` +
        `${err.message || 'Unknown error'}\n\n` +
        `Sell manually: CA \`${position.tokenMint}\``
      );
    }
  }

  // 🛡️ CRASH-PROOF TELEGRAM PIPELINE BYPASS
  private notifyUser(message: string) {
    const targetId = this.telegramChatId || (globalSettings as any).fallbackChatId;

    if (this.botInstance && targetId) {
      this.botInstance.telegram
        .sendMessage(targetId, message, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        })
        .catch((err) => console.error('[MONITOR] notifyUser standard error:', err));
    } else if (CONFIG.BOT_TOKEN && targetId) {
      const fallbackBot = new Telegraf(CONFIG.BOT_TOKEN);
      fallbackBot.telegram
        .sendMessage(targetId, message, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        })
        .catch((err: any) => console.error('[MONITOR] notifyUser fallback error:', err));
    } else {
      console.log(`📡 [RADAR OFFLINE LOG]:\n${message}`);
    }
  }
}

export const positionMonitor = new PositionMonitor();