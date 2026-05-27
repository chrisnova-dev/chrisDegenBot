import fetch from 'cross-fetch';
import { VersionedTransaction } from '@solana/web3.js';
import { solanaClient } from '../blockchain/connection';

const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

export class JupiterService {
  // FIX: Migrate away from sunset v6 domain to the unified Jupiter V2 API platform
  private apiBaseUrl = 'https://api.jup.ag/swap/v2';

  /**
   * Fetches the optimal trade routing parameters for an asset swap
   */
  public async getSwapQuote(targetTokenMint: string, amountInSol: number, slippageBps = 150): Promise<any> {
    const lamports = Math.floor(amountInSol * 1_000_000_000);
    const url = `${this.apiBaseUrl}/quote?inputMint=${WRAPPED_SOL_MINT}&outputMint=${targetTokenMint}&amount=${lamports}&slippageBps=${slippageBps}`;
    
    try {
      const response = await fetch(url);
      
      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown stream disconnect");
        this.decodeAndThrowError(`Quote API ${response.status}`, errorText);
      }
      
      return await response.json();
    } catch (err: any) {
      throw new Error(err.message || "Failed to establish a data route connection with Jupiter.");
    }
  }

  /**
   * Compiles the quote details into a complete, ready-to-sign transaction object
   */
  public async buildSwapTransaction(quoteResponse: any): Promise<VersionedTransaction> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey: solanaClient.wallet.publicKey.toBase58(), // Safe mapping string allocation
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 75_000 // Tipped up slightly to compete through network micro-congestion
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown parsing issue");
        this.decodeAndThrowError(`Swap Build API ${response.status}`, errorText);
      }

      const { swapTransaction } = await response.json();
      return VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    } catch (err: any) {
      throw new Error(err.message || "Failed to serialize trade transaction structures.");
    }
  }

  /**
   * Evaluates failing JSON payloads to output descriptive error notifications
   */
  private decodeAndThrowError(stage: string, rawMessage: string): void {
    const cleanMessage = rawMessage.toLowerCase();
    
    // 1. Check for insufficient trading gas balance
    if (cleanMessage.includes("insufficient") || cleanMessage.includes("not enough balance") || cleanMessage.includes("0x1")) {
      throw new Error("❌ Trade Stopped: Insufficient SOL balance in your wallet to complete the purchase and pay gas fees.");
    }
    
    // 2. Check for slippage breach (frequent on volatile launchpad assets)
    if (cleanMessage.includes("slippage") || cleanMessage.includes("slippage tolerance exceeded") || cleanMessage.includes("0x1771")) {
      throw new Error("🛑 Price Protection: Price moved too quickly! Increase your Slippage Tolerance % in ⚙️ Trade Settings.");
    }

    // 3. Check for empty pools or frozen market tokens
    if (cleanMessage.includes("no route found") || cleanMessage.includes("liquidity") || cleanMessage.includes("empty market")) {
      throw new Error("📉 Market Error: No stable liquidity route found for this asset on Raydium or Meteora pools.");
    }

    // 4. Fallback default parsing
    try {
      const parsed = JSON.parse(rawMessage);
      throw new Error(`⚠️ Jupiter Failure [${stage}]: ${parsed.error || parsed.message || rawMessage}`);
    } catch {
      throw new Error(`⚠️ Jupiter Failure [${stage}]: ${rawMessage}`);
    }
  }
}

export const jupiterService = new JupiterService();