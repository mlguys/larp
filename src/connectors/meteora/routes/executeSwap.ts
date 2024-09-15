import { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import DLMM from '@meteora-ag/dlmm';
import BN from "bn.js";
import { MeteoraController } from '../meteora.controller';
import { SolanaController } from '../../solana/solana.controller';
import { GetBalanceController } from '../../solana/routes/getBalance';

class ExecuteSwapController extends MeteoraController {
  async executeSwap(
    inputTokenSymbol: string,
    outputTokenSymbol: string,
    amount: number,
    poolAddress: string,
    slippageBps?: number,
    commitment: 'finalized' | 'confirmed' | 'processed' = 'finalized'
  ): Promise<{ 
    signature: string;
    inputTokenBefore: string;
    inputTokenAfter: string;
    outputTokenBefore: string;
    outputTokenAfter: string;
  }> {
    const solanaController = new SolanaController();
    const inputToken = await solanaController.getTokenBySymbol(inputTokenSymbol);
    const outputToken = await solanaController.getTokenBySymbol(outputTokenSymbol);

    if (!inputToken || !outputToken) {
      throw new Error('Invalid token symbols');
    }

    const dlmmPool = await DLMM.create(this.connection, new PublicKey(poolAddress));
    const swapAmount = new BN(amount * (10 ** inputToken.decimals));
    const swapForY = inputToken.address === dlmmPool.tokenX.publicKey.toBase58();

    const binArrays = await dlmmPool.getBinArrayForSwap(swapForY);

    const slippage = new BN(slippageBps || 100); // Default 1% slippage

    const swapQuote = await dlmmPool.swapQuote(swapAmount, swapForY, slippage, binArrays);

    const balanceController = new GetBalanceController();
    const getBalance = async (tokenAddress: string) => {
      const balances = JSON.parse(await balanceController.getBalance());
      const tokenBalance = balances.find(b => b.mint === tokenAddress);
      return tokenBalance ? tokenBalance.uiAmount : '0';
    };

    const inputTokenBefore = await getBalance(inputToken.address);
    const outputTokenBefore = await getBalance(outputToken.address);

    const swapTx = await dlmmPool.swap({
      inToken: new PublicKey(inputToken.address),
      outToken: new PublicKey(outputToken.address),
      inAmount: swapAmount,
      minOutAmount: swapQuote.minOutAmount,
      lbPair: dlmmPool.pubkey,
      user: this.keypair.publicKey,
      binArraysPubkey: swapQuote.binArraysPubkey,
    });

    const signature = await sendAndConfirmTransaction(this.connection, swapTx, [this.keypair], {
      commitment: commitment
    });

    const inputTokenAfter = await getBalance(inputToken.address);
    const outputTokenAfter = await getBalance(outputToken.address);

    return { 
      signature,
      inputTokenBefore: `${inputTokenSymbol} (before swap): ${inputTokenBefore}`,
      inputTokenAfter: `${inputTokenSymbol} (after swap): ${inputTokenAfter}`,
      outputTokenBefore: `${outputTokenSymbol} (before swap): ${outputTokenBefore}`,
      outputTokenAfter: `${outputTokenSymbol} (after swap): ${outputTokenAfter}`
    };
  }
}

export default function executeSwapRoute(fastify: FastifyInstance, folderName: string) {
  const controller = new ExecuteSwapController();

  fastify.post(`/${folderName}/execute-swap`, {
    schema: {
      tags: [folderName],
      description: 'Execute a swap on Meteora',
      body: Type.Object({
        inputTokenSymbol: Type.String(),
        outputTokenSymbol: Type.String(),
        amount: Type.Number(),
        poolAddress: Type.String(),
        slippageBps: Type.Optional(Type.Number({ default: 100, minimum: 0, maximum: 10000 })),
        commitment: Type.Optional(Type.Union([
          Type.Literal('finalized'),
          Type.Literal('confirmed'),
          Type.Literal('processed')
        ], { default: 'finalized' })),
      }),
      response: {
        200: Type.Object({
          signature: Type.String(),
          inputTokenBefore: Type.String(),
          inputTokenAfter: Type.String(),
          outputTokenBefore: Type.String(),
          outputTokenAfter: Type.String(),
        })
      }
    },
    handler: async (request) => {
      const { inputTokenSymbol, outputTokenSymbol, amount, poolAddress, slippageBps, commitment } = request.body as {
        inputTokenSymbol: string;
        outputTokenSymbol: string;
        amount: number;
        poolAddress: string;
        slippageBps?: number;
        commitment?: 'finalized' | 'confirmed' | 'processed';
      };
      fastify.log.info(`Executing Meteora swap from ${inputTokenSymbol} to ${outputTokenSymbol}`);
      const result = await controller.executeSwap(inputTokenSymbol, outputTokenSymbol, amount, poolAddress, slippageBps, commitment);
      return result;
    }
  });
}
