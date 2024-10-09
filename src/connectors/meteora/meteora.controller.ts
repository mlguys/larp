import { SolanaController } from '../solana/solana.controller';
import DLMM from '@meteora-ag/dlmm';
import { Cluster, PublicKey } from '@solana/web3.js';

export class MeteoraController extends SolanaController {
  private dlmmPools: Map<string, DLMM>;

  constructor() {
    super();
    this.dlmmPools = new Map();
  }

  async getDlmmPool(poolAddress: string): Promise<DLMM> {
    if (this.dlmmPools.has(poolAddress)) {
      return this.dlmmPools.get(poolAddress);
    }

    const dlmmPool = await DLMM.create(this.connection, new PublicKey(poolAddress), {
      cluster: this.network as Cluster,
    });
    this.dlmmPools.set(poolAddress, dlmmPool);

    return dlmmPool;
  }

  async extractTokenBalanceChangeAndFee(
    signature: string,
    mint: string,
    owner: string,
  ): Promise<{ balanceChange: number; fee: number }> {
    const txDetails = await this.connection.getParsedTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });

    const preTokenBalances = txDetails.meta?.preTokenBalances || [];
    const postTokenBalances = txDetails.meta?.postTokenBalances || [];

    const preBalance =
      preTokenBalances.find((balance) => balance.mint === mint && balance.owner === owner)
        ?.uiTokenAmount.uiAmount || 0;

    const postBalance =
      postTokenBalances.find((balance) => balance.mint === mint && balance.owner === owner)
        ?.uiTokenAmount.uiAmount || 0;

    const balanceChange = postBalance - preBalance;
    const fee = (txDetails.meta?.fee || 0) / 1_000_000_000; // Convert lamports to SOL

    return { balanceChange, fee };
  }
}
