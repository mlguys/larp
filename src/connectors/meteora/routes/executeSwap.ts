import { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { MeteoraController } from '../meteora.controller';
import { SolanaController } from '../../solana/solana.controller';

class ExecuteSwapController extends MeteoraController {
  async executeSwap(
    inputTokenSymbol: string,
    outputTokenSymbol: string,
    amount: number,
    poolAddress: string,
    slippageBps?: number,
  ): Promise<{
    signature: string;
    totalInputSwapped: number;
    totalOutputSwapped: number;
    fee: number;
  }> {
    const solanaController = new SolanaController();
    const inputToken = await solanaController.getTokenBySymbol(inputTokenSymbol);
    const outputToken = await solanaController.getTokenBySymbol(outputTokenSymbol);

    if (!inputToken || !outputToken) {
      throw new Error('Invalid token symbols');
    }

    // Initialize DLMM pool using MeteoraController
    const dlmmPool = await this.getDlmmPool(poolAddress);
    await dlmmPool.refetchStates();

    const swapAmount = new BN(amount * 10 ** inputToken.decimals);
    const swapForY = inputToken.address === dlmmPool.tokenX.publicKey.toBase58();

    const binArrays = await dlmmPool.getBinArrayForSwap(swapForY);

    const slippage = new BN(slippageBps || 100); // Default 1% slippage

    const swapQuote = dlmmPool.swapQuote(swapAmount, swapForY, slippage, binArrays);

    const swapTx = await dlmmPool.swap({
      inToken: new PublicKey(inputToken.address),
      outToken: new PublicKey(outputToken.address),
      inAmount: swapAmount,
      minOutAmount: swapQuote.minOutAmount,
      lbPair: dlmmPool.pubkey,
      user: this.keypair.publicKey,
      binArraysPubkey: swapQuote.binArraysPubkey,
    });

    const signature = await this.sendAndConfirmTransaction(swapTx, [this.keypair], poolAddress);

    const { balanceChange: inputBalanceChange, fee } = await this.extractTokenBalanceChangeAndFee(
      signature,
      inputToken.address,
      poolAddress,
    );

    const { balanceChange: outputBalanceChange } = await this.extractTokenBalanceChangeAndFee(
      signature,
      outputToken.address,
      poolAddress,
    );

    const totalInputSwapped = Math.abs(inputBalanceChange);
    let totalOutputSwapped = Math.abs(outputBalanceChange);

    // Deduct the fee from totalOutputSwapped if the output token is SOL
    if (outputToken.symbol === 'SOL') {
      totalOutputSwapped -= fee;
    }

    return {
      signature,
      totalInputSwapped,
      totalOutputSwapped,
      fee,
    };
  }
}

export default function executeSwapRoute(fastify: FastifyInstance, folderName: string): void {
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
      }),
      response: {
        200: Type.Object({
          signature: Type.String(),
          totalInputSwapped: Type.Number(),
          totalOutputSwapped: Type.Number(),
          fee: Type.Number(),
        }),
      },
    },
    handler: async (request, reply) => {
      const { inputTokenSymbol, outputTokenSymbol, amount, poolAddress, slippageBps } =
        request.body as {
          inputTokenSymbol: string;
          outputTokenSymbol: string;
          amount: number;
          poolAddress: string;
          slippageBps?: number;
        };
      try {
        fastify.log.info(`Executing Meteora swap from ${inputTokenSymbol} to ${outputTokenSymbol}`);
        const result = await controller.executeSwap(
          inputTokenSymbol,
          outputTokenSymbol,
          amount,
          poolAddress,
          slippageBps,
        );
        return result;
      } catch (error) {
        fastify.log.error(`Error executing swap: ${error.message}`);
        reply.status(500).send({ error: `Failed to execute swap: ${error.message}` });
      }
    },
  });
}
