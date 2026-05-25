// src/commands/withdraw.ts
import { Context } from 'telegraf';
import { sessionState } from './buy';
import { processDirectWithdrawal } from './wallet';

export const handleWithdrawCommand = async (ctx: Context) => {
  await ctx.reply('❌ Manual text command inputs are disabled. Open your premium dashboard via the 💳 Wallet Hub app layout button below.');
};

export const handleWithdrawText = async (ctx: Context, text: string) => {
  const chatId = ctx.chat!.id;
  const state = sessionState.get(chatId) as any;

  if (state) {
    delete state.pendingWithdrawAmount; // Clear active state flag instantly
  }

  const requestedAmount = parseFloat(text.trim());
  if (isNaN(requestedAmount) || requestedAmount <= 0) {
    return await ctx.reply('❌ Value criteria error. Allocation amount inputs must be explicit positive numeric expressions.');
  }

  return await processDirectWithdrawal(ctx, requestedAmount);
};