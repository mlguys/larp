import { SolanaController } from '../solana/solana.controller';
import DLMM from '@meteora-ag/dlmm';
import { Cluster, PublicKey } from '@solana/web3.js';

const dlmmPools: Map<string, DLMM> = new Map();
const dlmmPoolPromises: Map<string, Promise<DLMM>> = new Map();

export class MeteoraController extends SolanaController {
  constructor() {
    super();
  }

  async getDlmmPool(poolAddress: string): Promise<DLMM> {
    if (dlmmPools.has(poolAddress)) {
      return dlmmPools.get(poolAddress);
    }

    if (dlmmPoolPromises.has(poolAddress)) {
      return dlmmPoolPromises.get(poolAddress);
    }

    // Create a promise for the DLMM instance and store it in the promises map
    const dlmmPoolPromise = DLMM.create(this.connection, new PublicKey(poolAddress), {
      cluster: this.network as Cluster,
    }).then((dlmmPool) => {
      dlmmPools.set(poolAddress, dlmmPool); // Store the actual DLMM instance
      dlmmPoolPromises.delete(poolAddress); // Remove the promise from the map
      return dlmmPool;
    });

    dlmmPoolPromises.set(poolAddress, dlmmPoolPromise); // Temporarily store the promise

    return dlmmPoolPromise;
  }

  async extractTokenBalanceChangeAndFee(
    signature: string,
    mint: string,
    owner: string,
  ): Promise<{ balanceChange: number; fee: number }> {
    let txDetails;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        txDetails = await this.connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (txDetails) {
          break; // Exit loop if txDetails is not null
        } else {
          throw new Error('Transaction details are null');
        }
      } catch (error) {
        if (attempt < 19) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } else {
          // Return default values after 10 attempts
          console.error(`Error fetching transaction details: ${error.message}`);
          return { balanceChange: 0, fee: 0 };
        }
      }
    }

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

  async extractAccountBalanceChangeAndFee(
    signature: string,
    accountIndex: number,
  ): Promise<{ balanceChange: number; fee: number }> {
    let txDetails;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        txDetails = await this.connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (txDetails) {
          break; // Exit loop if txDetails is not null
        } else {
          throw new Error('Transaction details are null');
        }
      } catch (error) {
        if (attempt < 19) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } else {
          // Return default values after 10 attempts
          console.error(`Error fetching transaction details: ${error.message}`);
          return { balanceChange: 0, fee: 0 };
        }
      }
    }

    const preBalances = txDetails.meta?.preBalances || [];
    const postBalances = txDetails.meta?.postBalances || [];

    const balanceChange =
      Math.abs(postBalances[accountIndex] - preBalances[accountIndex]) / 1_000_000_000;
    const fee = (txDetails.meta?.fee || 0) / 1_000_000_000; // Convert lamports to SOL

    return { balanceChange, fee };
  }
}
