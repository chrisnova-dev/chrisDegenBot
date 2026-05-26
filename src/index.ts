import { Telegraf, Markup } from 'telegraf';
import { CONFIG } from './config/env';
import { handleWalletCommand, handleWalletCallback } from './commands/wallet';
import { handleWithdrawText } from './commands/withdraw';
import {
  handleContractPaste,
  sessionState,
  sendInteractiveDashboard,
  executeFinalOrder,
} from './commands/buy';
import {
  handleTrackButton,
  handleTrackAddressPaste,
  handleTrackNameInput,
  handleListWallets,
  handleTrackCallback,
  handleEditWalletName,
} from './commands/track';
import {
  sendSettingsMenu,
  handleSettingsCallback,
  handleSettingsTextInput,
} from './commands/settings';
import { positionMonitor } from './services/monitor';
import { globalSettings } from './services/state'; // ✅ No more circular import

const bot = new Telegraf(CONFIG.BOT_TOKEN);

const ALLOWED_USER_ID = 7104555711; // Your Telegram ID

// ─── SECURITY GATE ────────────────────────────────────────────
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== ALLOWED_USER_ID) {
    console.log(`🛡️ Blocked: ${ctx.from?.id}`);
    return;
  }
  return next();
});

// ─── KEYBOARD ─────────────────────────────────────────────────
const appKeyboard = Markup.keyboard([
  ['🎯 Track Wallet', '📋 List Wallets'],
  ['⚙️ Trade Settings', '💸 Withdraw'],
  ['💳 Wallet Hub', '🔥 Trending'],
]).resize();

const KEYBOARD_TEXTS = [
  '🎯 Track Wallet',
  '📋 List Wallets',
  '⚙️ Trade Settings',
  '💸 Withdraw',
  '💳 Wallet Hub',
  '🔥 Trending',
];

// ─── START ─────────────────────────────────────────────────────
bot.start((ctx) => {
  positionMonitor.initialize(ctx.telegram as any, ctx.chat.id);
  ctx.reply(
    `⚡ *NOVATRACK PRIVATE TERMINAL*\n\nSystem ready. Use the buttons below.`,
    { parse_mode: 'Markdown', ...appKeyboard }
  );
});

// ─── BUTTON ROUTING ───────────────────────────────────────────
bot.hears('🎯 Track Wallet', handleTrackButton);
bot.hears('📋 List Wallets', handleListWallets);
bot.hears('⚙️ Trade Settings', sendSettingsMenu);
bot.hears('💳 Wallet Hub', handleWalletCommand);
bot.hears('💸 Withdraw', handleWalletCommand); // Opens wallet hub which has withdraw button
bot.hears('🔥 Trending', async (ctx) => {
  await ctx.reply('🔥 *Trending* — Coming soon!', { parse_mode: 'Markdown' });
});

// ─── CALLBACK QUERY ROUTER ────────────────────────────────────
bot.on('callback_query', async (ctx) => {
  // @ts-ignore
  const action = ctx.callbackQuery.data as string;
  const chatId = ctx.chat!.id;

  positionMonitor.initialize(ctx.telegram as any, chatId);

  // Wallet & withdraw callbacks
  if (action.startsWith('wallet_') || action.startsWith('with_')) {
    return await handleWalletCallback(ctx, action);
  }

  // Track wallet callbacks
  if (action.startsWith('track_')) {
    return await handleTrackCallback(ctx, action);
  }

  // Settings callbacks
  if (action.startsWith('cfg_')) {
    return await handleSettingsCallback(ctx, action);
  }

  // Trade dashboard callbacks
  const state = sessionState.get(chatId);
  if (!state) {
    return await ctx.answerCbQuery('❌ Session expired. Paste the CA again.', {
      show_alert: true,
    });
  }

  if (action.startsWith('set_amt_')) {
    state.selectedAmountSol = parseFloat(action.replace('set_amt_', ''));
  } else if (action.startsWith('set_tp_')) {
    state.selectedTakeProfit = parseFloat(action.replace('set_tp_', ''));
  } else if (action.startsWith('set_sl_')) {
    state.selectedStopLoss = parseFloat(action.replace('set_sl_', '')) / 100;
  } else if (action === 'reset_dashboard') {
    state.selectedAmountSol = globalSettings.defaultSolAllocation;
    state.selectedTakeProfit = globalSettings.defaultTakeProfit;
    state.selectedStopLoss = globalSettings.defaultStopLoss;
  } else if (action === 'execute_order_swap') {
    if (!state.selectedAmountSol || state.selectedAmountSol === 0) {
      return await ctx.answerCbQuery('🛑 Set a buy amount first!', {
        show_alert: true,
      });
    }
    await ctx.answerCbQuery('🚀 Executing...');
    await ctx.deleteMessage().catch(() => {});
    return await executeFinalOrder(ctx, chatId);
  }

  await ctx.answerCbQuery('✅ Updated');
  await sendInteractiveDashboard(ctx, chatId, true);
});

// ─── TEXT MESSAGE HANDLER ─────────────────────────────────────
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  const chatId = ctx.chat.id;
  const state = sessionState.get(chatId) as any;

  positionMonitor.initialize(ctx.telegram as any, chatId);

  // Ignore keyboard button presses (handled by bot.hears)
  if (KEYBOARD_TEXTS.includes(text)) return;

  // Handle active pending states
  if (state?.pendingAction) {
    const action: string = state.pendingAction;

    // Track flow: waiting for wallet address
    if (action === 'awaiting_track_address') {
      delete state.pendingAction;
      return await handleTrackAddressPaste(ctx, text);
    }

    // Track flow: waiting for wallet nickname
    if (action === 'awaiting_track_name') {
      delete state.pendingAction;
      return await handleTrackNameInput(ctx, text);
    }

    // Track flow: renaming an existing wallet
    if (action.startsWith('edit_wallet_name_')) {
      const address = action.replace('edit_wallet_name_', '');
      delete state.pendingAction;
      return await handleEditWalletName(ctx, address, text);
    }

    // Settings: numeric/text input for a setting
    if (action.startsWith('cfg_')) {
      delete state.pendingAction;
      return await handleSettingsTextInput(ctx, action, text);
    }
  }

  // Withdraw custom amount
  if (state?.pendingWithdrawAmount) {
    return await handleWithdrawText(ctx, text);
  }

  // Default: try as a contract address
  await handleContractPaste(ctx, text);
});

bot.launch()
  .then(() => {
    console.log('🤖 NOVATRACK running!');

    positionMonitor.initializeFromStart(bot, ALLOWED_USER_ID);
  })
  .catch((err) => console.error('[BOT] Launch error:', err));
