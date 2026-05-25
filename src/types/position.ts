export interface Position {
  tokenMint: string;
  tokenSymbol: string;
  buyPriceUsd: number;
  amountTokens: number;
  initialSolSpent: number;
  takeProfitMultiplier: number;
  stopLossPercent: number;
  timestamp: number;
}

export interface UserSessionState {
  // Buy flow
  pendingTokenCA?: string;
  pendingSymbol?: string;
  pendingPriceUsd?: number;
  selectedAmountSol?: number;
  selectedTakeProfit?: number;
  selectedStopLoss?: number;
  // Market data cache
  marketCap?: string;
  liquidity?: string;
  change5m?: string;
  change1h?: string;
  // Shared pending state
  pendingAction?: string;
  pendingWithdrawAmount?: boolean;
  // Track wallet flow
  pendingTrackAddress?: string;
}

export interface TrackedWallet {
  address: string;
  name: string;
  subscriptionId?: number;
  isActive: boolean;
  addedAt: number;
}

export interface MirroredTrader {
  walletAddress: string;
  label: string;
  copyBuyAmountSol: number;
  isTracking: boolean;
  subscriptionId?: number;
}

export interface GlobalSettings {
  defaultSolAllocation: number;
  defaultTakeProfit: number;
  defaultStopLoss: number;
  savedWithdrawAddress: string;
  customBuyAmounts: number[]; 
  customTakeProfits: number[];
  customStopLosses: number[];
  autoSellEnabled: boolean;
}