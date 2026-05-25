import { Context, Markup } from 'telegraf';
import { PublicKey } from '@solana/web3.js';
import fetch from 'cross-fetch';
import { jupiterService } from '../services/jupiter';
import { solanaClient } from '../blockchain/connection';
import { positionMonitor } from '../services/monitor';
import { UserSessionState } from '../types/position';
import { globalSettings } from '../services/state'; // ✅ Fixed import

export const sessionState: Map<number, UserSessionState> = new Map();

export const handleContractPaste = async (ctx: Context, text: string) => {
  const chatId = ctx.chat!.id;
  const targetCA = text.trim();

  try {
    new PublicKey(targetCA);
  } catch {
    return; // Not a valid CA, ignore silently
  }

  const fetchingMsg = await ctx.reply('🔍 Loading token data...');

  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${targetCA}`);
    const data = await response.json();

    if (!data.pairs || data.pairs.length === 0) {
      await ctx.telegram.deleteMessage(chatId, fetchingMsg.message_id).catch(() => {});
      return await ctx.reply('❌ Token not found on DexScreener. Double check the CA.');
    }

    const pair = data.pairs[0];
    const symbol = pair.baseToken.symbol || 'UNKNOWN';
    const priceUsd = parseFloat(pair.priceUsd || '0');
    const marketCap = pair.marketCap ? `$${pair.marketCap.toLocaleString()}` : 'N/A';
    const liquidity = pair.liquidity?.usd ? `$${pair.liquidity.usd.toLocaleString()}` : 'N/A';
    const change5m = pair.priceChange?.m5 ?? '0';
    const change1h = pair.priceChange?.h1 ?? '0';

    sessionState.set(chatId, {
      pendingTokenCA: targetCA,
      pendingSymbol: symbol,
      pendingPriceUsd: priceUsd,
      selectedAmountSol: globalSettings.defaultSolAllocation,
      selectedTakeProfit: globalSettings.defaultTakeProfit,
      selectedStopLoss: globalSettings.defaultStopLoss,
      marketCap,
      liquidity,
      change5m: String(change5m),
      change1h: String(change1h),
    });

    await ctx.telegram.deleteMessage(chatId, fetchingMsg.message_id).catch(() => {});
    await sendInteractiveDashboard(ctx, chatId, false);

  } catch (error) {
    console.error('[BUY] handleContractPaste error:', error);
    await ctx.reply('💥 Failed to load token data. Try again.');
  }
};

export const sendInteractiveDashboard = async (
  ctx: Context,
  chatId: number,
  editMessage = false
) => {
  const state = sessionState.get(chatId);
  if (!state) return;

  // Pull YOUR custom button values from settings
  const [buy1, buy2, buy3] = globalSettings.customBuyAmounts;
  const [tp1, tp2, tp3] = globalSettings.customTakeProfits;
  const [sl1, sl2, sl3] = globalSettings.customStopLosses;

  const amtDisplay = state.selectedAmountSol
    ? `${state.selectedAmountSol} SOL` : 'NOT SET';
  const tpDisplay = state.selectedTakeProfit
    ? `${state.selectedTakeProfit}x` : 'NOT SET';
  const slDisplay = state.selectedStopLoss
    ? `-${(state.selectedStopLoss * 100).toFixed(0)}%` : 'NOT SET';

  const text =
    `🪙 *${state.pendingSymbol}*\n` +
    `\`${state.pendingTokenCA}\`\n\n` +
    `📊 MCap: \`${state.marketCap || 'N/A'}\`\n` +
    `💧 Liquidity: \`${state.liquidity || 'N/A'}\`\n` +
    `📈 5m: \`${state.change5m}%\` | 1h: \`${state.change1h}%\`\n\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `💰 Buy: \`${amtDisplay}\`\n` +
    `🎯 Take Profit: \`${tpDisplay}\`\n` +
    `🚨 Stop Loss: \`${slDisplay}\`\n` +
    `━━━━━━━━━━━━━━━━━━━`;

  const keyboard = Markup.inlineKeyboard([
    // YOUR custom buy amounts
    [
      Markup.button.callback(`💰 ${buy1}`, `set_amt_${buy1}`),
      Markup.button.callback(`💰 ${buy2}`, `set_amt_${buy2}`),
      Markup.button.callback(`💰 ${buy3}`, `set_amt_${buy3}`),
    ],
    // YOUR custom take profits
    [
      Markup.button.callback(`🎯 ${tp1}x`, `set_tp_${tp1}`),
      Markup.button.callback(`🎯 ${tp2}x`, `set_tp_${tp2}`),
      Markup.button.callback(`🎯 ${tp3}x`, `set_tp_${tp3}`),
    ],
    // YOUR custom stop losses
    [
      Markup.button.callback(`🚨 -${sl1}%`, `set_sl_${sl1}`),
      Markup.button.callback(`🚨 -${sl2}%`, `set_sl_${sl2}`),
      Markup.button.callback(`🔄 Reset`, 'reset_dashboard'),
    ],
    [Markup.button.callback('⚡ BUY NOW ⚡', 'execute_order_swap')],
  ]);

  try {
    if (editMessage && ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    } else {
      await ctx.replyWithMarkdown(text, keyboard);
    }
  } catch {
    await ctx.replyWithMarkdown(text, keyboard);
  }
};


export const executeFinalOrder = async (ctx: Context, chatId: number) => {
  const state = sessionState.get(chatId);
  if (!state || !state.pendingTokenCA) return;

  await ctx.reply(
    `🚀 Buying ${state.selectedAmountSol} SOL of $${state.pendingSymbol}...`
  );

  try {
    const quote = await jupiterService.getSwapQuote(
      state.pendingTokenCA,
      state.selectedAmountSol!
    );
    const transaction = await jupiterService.buildSwapTransaction(quote);

    transaction.sign([solanaClient.wallet]);
    const rawTx = transaction.serialize();
    const txid = await solanaClient.connection.sendRawTransaction(rawTx, {
      skipPreflight: true,
      maxRetries: 2,
    });

    const tokensBought = parseFloat(quote.outAmount);

    positionMonitor.initialize(ctx.telegram as any, chatId);
    positionMonitor.trackPosition({
      tokenMint: state.pendingTokenCA,
      tokenSymbol: state.pendingSymbol!,
      buyPriceUsd: state.pendingPriceUsd!,
      amountTokens: tokensBought,
      initialSolSpent: state.selectedAmountSol!,
      takeProfitMultiplier: state.selectedTakeProfit!,
      stopLossPercent: state.selectedStopLoss!,
      timestamp: Date.now(),
    });

    await ctx.reply(
      `🟩 *BUY ORDER EXECUTED!*\n\n` +
      `🪙 Token: $${state.pendingSymbol}\n` +
      `💰 Spent: ${state.selectedAmountSol} SOL\n` +
      `🎯 TP: ${state.selectedTakeProfit}x | 🚨 SL: -${((state.selectedStopLoss || 0) * 100).toFixed(0)}%\n` +
      `🔗 [View on Solscan](https://solscan.io/tx/${txid})\n\n` +
      `🤖 Auto-monitoring active.`,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );

    sessionState.delete(chatId);
  } catch (error: any) {
    console.error('[BUY] executeFinalOrder error:', error);
    await ctx.reply(`🛑 Buy failed: ${error.message || 'Unknown error'}`);
  }
};