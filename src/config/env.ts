import dotenv from 'dotenv';
dotenv.config();

if (!process.env.BOT_TOKEN) throw new Error('❌ BOT_TOKEN missing from .env');
if (!process.env.PRIVATE_KEY) throw new Error('❌ PRIVATE_KEY missing from .env');

export const CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  PRIVATE_KEY: process.env.PRIVATE_KEY,
};