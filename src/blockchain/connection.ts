import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { CONFIG } from '../config/env';

class SolanaClient {
  private _connection: Connection;
  private _wallet: Keypair;

  constructor() {
    this._connection = new Connection(CONFIG.RPC_URL, 'confirmed');
    this._wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(CONFIG.PRIVATE_KEY)));
    console.log(`🔑 Premium Wallet Loaded: ${this._wallet.publicKey.toBase58()}`);
  }

  public get connection(): Connection { return this._connection; }
  public get wallet(): Keypair { return this._wallet; }
  public get publicKey(): string { return this._wallet.publicKey.toBase58(); }

  public async getBalance(): Promise<number> {
    const lamports = await this._connection.getBalance(this._wallet.publicKey);
    return lamports / 1_000_000_000;
  }

  public async executeWithdrawal(destinationStr: string, amountSol: number): Promise<string> {
    const destPublicKey = new PublicKey(destinationStr);
    const lamports = Math.floor(amountSol * 1_000_000_000);

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this._wallet.publicKey,
        toPubkey: destPublicKey,
        lamports,
      })
    );

    tx.feePayer = this._wallet.publicKey;
    const { blockhash } = await this._connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    return await sendAndConfirmTransaction(this._connection, tx, [this._wallet]);
  }
}

export const solanaClient = new SolanaClient();