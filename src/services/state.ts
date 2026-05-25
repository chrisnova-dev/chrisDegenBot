import { GlobalSettings, TrackedWallet } from '../types/position';

export const globalSettings: GlobalSettings = {
  defaultSolAllocation: 0,
  defaultTakeProfit: 0,
  defaultStopLoss: 0,
  savedWithdrawAddress: '',
  customBuyAmounts: [0.1, 0.5, 1.0],
  customTakeProfits: [2, 3, 5],   
  customStopLosses: [15, 30, 50],  
  autoSellEnabled: true,
};

export const trackedWallets: Map<string, TrackedWallet> = new Map();