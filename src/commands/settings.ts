import { Context, Markup } from 'telegraf';
import { globalSettings } from '../services/state';
import { sessionState } from './buy';

export const sendSettingsMenu = async (ctx: Context) => {
  const [buy1, buy2, buy3] = globalSettings.customBuyAmounts;
  const [tp1, tp2, tp3] = globalSettings.customTakeProfits;
  const [sl1, sl2, sl3] = globalSettings.customStopLosses;

  const text =
    `⚙️ *TRADE SETTINGS*\n\n` +
    `💰 *Quick Buy Buttons:*\n` +
    `  Btn 1: \`${buy1} SOL\`  Btn 2: \`${buy2} SOL\`  Btn 3: \`${buy3} SOL\`\n\n` +
    `🎯 *Take Profit Buttons:*\n` +
    `  Btn 1: \`${tp1}x\`  Btn 2: \`${tp2}x\`  Btn 3: \`${tp3}x\`\n\n` +
    `🚨 *Stop Loss Buttons:*\n` +
    `  Btn 1: \`-${sl1}%\`  Btn 2: \`-${sl2}%\`  Btn 3: \`-${sl3}%\`\n\n` +
    `🤖 *Auto Sell:* \`${globalSettings.autoSellEnabled ? '✅ ON' : '❌ OFF'}\`\n\n` +
    `🏦 *Withdrawal Address:*\n` +
    `\`${globalSettings.savedWithdrawAddress || 'Not configured'}\`\n\n` +
    `_Tap any button below to change it._`;

  const keyboard = Markup.inlineKeyboard([
    // Buy amount buttons
    [
      Markup.button.callback(`💰 Buy 1: ${buy1}`, 'cfg_buy1'),
      Markup.button.callback(`💰 Buy 2: ${buy2}`, 'cfg_buy2'),
      Markup.button.callback(`💰 Buy 3: ${buy3}`, 'cfg_buy3'),
    ],
    // Take profit buttons
    [
      Markup.button.callback(`🎯 TP 1: ${tp1}x`, 'cfg_tp1'),
      Markup.button.callback(`🎯 TP 2: ${tp2}x`, 'cfg_tp2'),
      Markup.button.callback(`🎯 TP 3: ${tp3}x`, 'cfg_tp3'),
    ],
    // Stop loss buttons
    [
      Markup.button.callback(`🚨 SL 1: -${sl1}%`, 'cfg_sl1'),
      Markup.button.callback(`🚨 SL 2: -${sl2}%`, 'cfg_sl2'),
      Markup.button.callback(`🚨 SL 3: -${sl3}%`, 'cfg_sl3'),
    ],
    [
      Markup.button.callback(
        globalSettings.autoSellEnabled
          ? '🤖 Auto Sell: ON (tap to disable)'
          : '🤖 Auto Sell: OFF (tap to enable)',
        'cfg_toggle_autosell'
      ),
    ],
    [Markup.button.callback('🏦 Set Withdrawal Address', 'cfg_addr')],
    [Markup.button.callback('🔄 Reset All to Default', 'cfg_reset')],
  ]);

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
    });
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  }
};

export const handleSettingsCallback = async (ctx: Context, action: string) => {
  const chatId = ctx.chat!.id;

  if (action === 'cfg_toggle_autosell') {
    globalSettings.autoSellEnabled = !globalSettings.autoSellEnabled;
    await ctx.answerCbQuery(
      `Auto sell ${globalSettings.autoSellEnabled ? 'enabled ✅' : 'disabled ❌'}`
    );
    return await sendSettingsMenu(ctx);
  }

  if (action === 'cfg_reset') {
    globalSettings.customBuyAmounts = [0.1, 0.5, 1.0];
    globalSettings.customTakeProfits = [2, 3, 5];
    globalSettings.customStopLosses = [15, 30, 50];
    globalSettings.defaultSolAllocation = 0;
    globalSettings.defaultTakeProfit = 0;
    globalSettings.defaultStopLoss = 0;
    globalSettings.autoSellEnabled = true;
    await ctx.answerCbQuery('✅ Reset to default');
    return await sendSettingsMenu(ctx);
  }

  const prompts: Record<string, string> = {
    cfg_buy1: '💰 Enter SOL amount for *Buy Button 1* (e.g., `0.1`):',
    cfg_buy2: '💰 Enter SOL amount for *Buy Button 2* (e.g., `0.5`):',
    cfg_buy3: '💰 Enter SOL amount for *Buy Button 3* (e.g., `1.0`):',
    cfg_tp1:  '🎯 Enter Take Profit for *TP Button 1* — multiplier (e.g., `2` = 2x):',
    cfg_tp2:  '🎯 Enter Take Profit for *TP Button 2* — multiplier (e.g., `3` = 3x):',
    cfg_tp3:  '🎯 Enter Take Profit for *TP Button 3* — multiplier (e.g., `5` = 5x):',
    cfg_sl1:  '🚨 Enter Stop Loss for *SL Button 1* — percentage (e.g., `15` = -15%):',
    cfg_sl2:  '🚨 Enter Stop Loss for *SL Button 2* — percentage (e.g., `30` = -30%):',
    cfg_sl3:  '🚨 Enter Stop Loss for *SL Button 3* — percentage (e.g., `50` = -50%):',
    cfg_addr: '🏦 Paste your withdrawal wallet address:',
  };

  if (!prompts[action]) return;

  const state = sessionState.get(chatId) || {};
  (state as any).pendingAction = action;
  sessionState.set(chatId, state as any);

  await ctx.answerCbQuery();
  await ctx.reply(prompts[action], { parse_mode: 'Markdown' });
};

export const handleSettingsTextInput = async (
  ctx: Context,
  action: string,
  value: string
): Promise<boolean> => {
  const num = parseFloat(value.trim());

  switch (action) {
    case 'cfg_buy1':
      if (isNaN(num) || num <= 0) { await ctx.reply('❌ Enter a positive number.'); return false; }
      globalSettings.customBuyAmounts[0] = num;
      break;
    case 'cfg_buy2':
      if (isNaN(num) || num <= 0) { await ctx.reply('❌ Enter a positive number.'); return false; }
      globalSettings.customBuyAmounts[1] = num;
      break;
    case 'cfg_buy3':
      if (isNaN(num) || num <= 0) { await ctx.reply('❌ Enter a positive number.'); return false; }
      globalSettings.customBuyAmounts[2] = num;
      break;
    case 'cfg_tp1':
      if (isNaN(num) || num <= 1) { await ctx.reply('❌ Must be greater than 1. e.g. `2`'); return false; }
      globalSettings.customTakeProfits[0] = num;
      break;
    case 'cfg_tp2':
      if (isNaN(num) || num <= 1) { await ctx.reply('❌ Must be greater than 1.'); return false; }
      globalSettings.customTakeProfits[1] = num;
      break;
    case 'cfg_tp3':
      if (isNaN(num) || num <= 1) { await ctx.reply('❌ Must be greater than 1.'); return false; }
      globalSettings.customTakeProfits[2] = num;
      break;
    case 'cfg_sl1':
      if (isNaN(num) || num <= 0 || num > 100) { await ctx.reply('❌ Enter 1–100.'); return false; }
      globalSettings.customStopLosses[0] = num;
      break;
    case 'cfg_sl2':
      if (isNaN(num) || num <= 0 || num > 100) { await ctx.reply('❌ Enter 1–100.'); return false; }
      globalSettings.customStopLosses[1] = num;
      break;
    case 'cfg_sl3':
      if (isNaN(num) || num <= 0 || num > 100) { await ctx.reply('❌ Enter 1–100.'); return false; }
      globalSettings.customStopLosses[2] = num;
      break;
    case 'cfg_addr':
      if (!value.trim() || value.trim().length < 32) { await ctx.reply('❌ Invalid address.'); return false; }
      globalSettings.savedWithdrawAddress = value.trim();
      break;
    default:
      return false;
  }

  await ctx.reply('✅ Saved!');
  await sendSettingsMenu(ctx);
  return true;
};