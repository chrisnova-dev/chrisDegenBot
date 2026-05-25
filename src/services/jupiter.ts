import fetch from 'cross-fetch';
import { VersionedTransaction } from '@solana/web3.js';
import { solanaClient } from '../blockchain/connection';

const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

export class JupiterService {
  private apiBaseUrl = 'https://quote-api.jup.ag/v6';

  public async getSwapQuote(targetTokenMint: string, amountInSol: number, slippageBps = 150): Promise<any> {
    const lamports = Math.floor(amountInSol * 1_000_000_000);
    const url = `${this.apiBaseUrl}/quote?inputMint=${WRAPPED_SOL_MINT}&outputMint=${targetTokenMint}&amount=${lamports}&slippageBps=${slippageBps}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Jupiter Quote Error: ${response.status}`);
    return await response.json();
  }

  public async buildSwapTransaction(quoteResponse: any): Promise<VersionedTransaction> {
    const response = await fetch(`${this.apiBaseUrl}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: solanaClient.publicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 50_000 // Anti-MEV premium prioritization tipping
      }),
    });
    if (!response.ok) throw new Error(`Jupiter Swap Error: ${response.status}`);
    const { swapTransaction } = await response.json();
    return VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  }
}

export const jupiterService = new JupiterService();