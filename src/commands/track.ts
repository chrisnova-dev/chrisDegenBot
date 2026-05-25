import { Context, Markup } from 'telegraf';
import { PublicKey } from '@solana/web3.js';
import { positionMonitor } from '../services/monitor';
import { trackedWallets } from '../services/state';
import { sessionState } from './buy';

// Called when user taps "🎯 Track Wallet"
export const handleTrackButton = async (ctx: Context) => {
  const chatId = ctx.chat!.id;
  const state = sessionState.get(chatId) || {};
  (state as any).pendingAction = 'awaiting_track_address';
  sessionState.set(chatId, state as any);

  await ctx.reply(
    `🎯 *WALLET TRACKER*\n\n` +
    `Paste the Solana wallet address you want to monitor.\n\n` +
    `You'll get an instant alert every time they buy or sell any token.`,
    { parse_mode: 'Markdown' }
  );
};

// Called when user pastes address during track flow
export const handleTrackAddressPaste = async (
  ctx: Context,
  address: string
): Promise<void> => {
  const chatId = ctx.chat!.id;
  const trimmed = address.trim();

  try {
    new PublicKey(trimmed);
  } catch {
    await ctx.reply('❌ Invalid wallet address. Please paste a valid Solana address.');
    // Re-set pending so they can try again
    const state = sessionState.get(chatId) || {};
    (state as any).pendingAction = 'awaiting_track_address';
    sessionState.set(chatId, state as any);
    return;
  }

  if (trackedWallets.has(trimmed)) {
    await ctx.reply(
      `⚠️ Already tracking this wallet.\n` +
      `Check your list with the 📋 List Wallets button.`
    );
    return;
  }

  const state = sessionState.get(chatId) || {};
  (state as any).pendingAction = 'awaiting_track_name';
  (state as any).pendingTrackAddress = trimmed;
  sessionState.set(chatId, state as any);

  await ctx.reply(
    `✅ Valid address!\n\n` +
    `Give this wallet a nickname so you can recognize it.\n` +
    `_(e.g., "Whale Alpha", "Dev Wallet", "Insider 1")_\n\n` +
    `Or type \`skip\` to use the short address as the name.`,
    { parse_mode: 'Markdown' }
  );
};

// Called when user types the wallet nickname
export const handleTrackNameInput = async (
  ctx: Context,
  nameInput: string
) => {
  const chatId = ctx.chat!.id;
  const state = sessionState.get(chatId) as any;

  if (!state?.pendingTrackAddress) {
    await ctx.reply('❌ Session expired. Tap 🎯 Track Wallet and try again.');
    return;
  }

  const address = state.pendingTrackAddress;
  const walletName =
    nameInput.toLowerCase() === 'skip'
      ? `${address.slice(0, 6)}...${address.slice(-4)}`
      : nameInput.trim().slice(0, 32); // max 32 chars

  delete state.pendingAction;
  delete state.pendingTrackAddress;

  positionMonitor.initialize(ctx.telegram as any, chatId);
  await positionMonitor.addTrackedWallet(address, walletName);

  await ctx.reply(
    `🟩 *Tracking Started!*\n\n` +
    `👤 Name: *${walletName}*\n` +
    `📍 Address: \`${address}\`\n\n` +
    `You'll get live alerts whenever this wallet trades on Solana.`,
    { parse_mode: 'Markdown' }
  );
};

// Called when user taps "📋 List Wallets"
export const handleListWallets = async (ctx: Context) => {
  const wallets = Array.from(trackedWallets.values());

  if (wallets.length === 0) {
    const msg =
      `📋 *Tracked Wallets*\n\n` +
      `You're not tracking any wallets yet.\n` +
      `Tap 🎯 Track Wallet to add one.`;

    if (ctx.callbackQuery) {
      await ctx.editMessageText(msg, { parse_mode: 'Markdown' }).catch(() => {});
    } else {
      await ctx.reply(msg, { parse_mode: 'Markdown' });
    }
    return;
  }

  let text = `📋 *Tracked Wallets (${wallets.length})*\n\n`;
  const buttons: ReturnType<typeof Markup.button.callback>[][] = [];

  for (const wallet of wallets) {
    const status = wallet.isActive ? '🟢' : '🔴';
    text +=
      `${status} *${wallet.name}*\n` +
      `\`${wallet.address.slice(0, 8)}...${wallet.address.slice(-8)}\`\n\n`;

    buttons.push([
      Markup.button.callback(`✏️ Rename: ${wallet.name}`, `track_edit_${wallet.address}`),
      Markup.button.callback(`🗑️ Remove`, `track_remove_${wallet.address}`),
    ]);
  }

  const keyboard = Markup.inlineKeyboard(buttons);

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
    });
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  }
};

// Handles inline button callbacks from the list
export const handleTrackCallback = async (ctx: Context, action: string) => {
  const chatId = ctx.chat!.id;

  if (action.startsWith('track_edit_')) {
    const address = action.replace('track_edit_', '');
    const wallet = trackedWallets.get(address);
    if (!wallet) return await ctx.answerCbQuery('❌ Wallet not found.');

    const state = sessionState.get(chatId) || {};
    (state as any).pendingAction = `edit_wallet_name_${address}`;
    sessionState.set(chatId, state as any);

    await ctx.answerCbQuery();
    await ctx.reply(
      `✏️ *Rename wallet*\n\n` +
      `Current name: *${wallet.name}*\n` +
      `\`${address.slice(0, 8)}...${address.slice(-8)}\`\n\n` +
      `Type the new name:`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (action.startsWith('track_remove_')) {
    const address = action.replace('track_remove_', '');
    const wallet = trackedWallets.get(address);
    if (!wallet) return await ctx.answerCbQuery('❌ Wallet not found.');

    await positionMonitor.removeTrackedWallet(address);
    await ctx.answerCbQuery(`🗑️ Removed: ${wallet.name}`);
    await handleListWallets(ctx);
    return;
  }
};

// Called after user types new name during rename flow
export const handleEditWalletName = async (
  ctx: Context,
  address: string,
  newName: string
) => {
  const wallet = trackedWallets.get(address);
  if (!wallet) {
    await ctx.reply('❌ Wallet not found. It may have already been removed.');
    return;
  }

  const trimmedName = newName.trim().slice(0, 32);
  wallet.name = trimmedName;
  trackedWallets.set(address, wallet);

  await ctx.reply(
    `✅ *Wallet renamed!*\n\n` +
    `📍 \`${address.slice(0, 8)}...${address.slice(-8)}\`\n` +
    `👤 New name: *${trimmedName}*`,
    { parse_mode: 'Markdown' }
  );
};