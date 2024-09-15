import { BN } from '@coral-xyz/anchor';
import { MeteoraController } from '../meteora.controller';
import DLMM, { StrategyType } from '@meteora-ag/dlmm';
import { Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { FastifyInstance } from 'fastify';
import Decimal from 'decimal.js';
import { MAX_ACTIVE_BIN_SLIPPAGE } from '@meteora-ag/dlmm';
import { Type } from '@sinclair/typebox';

class OpenPositionController extends MeteoraController {
  async openPosition(
    baseSymbol: string,
    quoteSymbol: string,
    lowerPrice: Decimal,
    upperPrice: Decimal,
    poolAddress: string,
    baseTokenAmount: number,
    quoteTokenAmount: number,
    slippagePct?: number,
  ): Promise<{ signature: string; positionAddress: string }> {
    // TODO: if no pool address is provided => find pool by symbol
    const newImbalancePosition = new Keypair();
    const dlmmPoolPubkey = new PublicKey(poolAddress);
    const dlmmPool = await DLMM.create(this.connection, dlmmPoolPubkey);

    // Update pool state
    await dlmmPool.refetchStates()

    const minBinId = dlmmPool.getBinIdFromPrice(lowerPrice.toNumber(), true) - 1;
    const maxBinId = dlmmPool.getBinIdFromPrice(upperPrice.toNumber(), false) + 1;

    const totalXAmount = new BN(baseTokenAmount);
    const totalYAmount = new BN(quoteTokenAmount);

    // Create Position
    const createPositionTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: newImbalancePosition.publicKey,
      user: this.keypair.publicKey,
      totalXAmount,
      totalYAmount,
      strategy: {
        maxBinId,
        minBinId,
        strategyType: StrategyType.SpotImBalanced,
      },
      slippage: slippagePct ? slippagePct : MAX_ACTIVE_BIN_SLIPPAGE,
    });

    try {
      const createImbalancePositionTxHash = await sendAndConfirmTransaction(
        this.connection,
        createPositionTx,
        [this.keypair, newImbalancePosition],
      );
      console.log('🚀 ~ createImbalancePositionTxHash:', createImbalancePositionTxHash);

      return {
        signature: createImbalancePositionTxHash ? createImbalancePositionTxHash : '',
        positionAddress: newImbalancePosition.publicKey.toBase58(),
      };
    } catch (error) {
      console.log('🚀 ~ error:', JSON.parse(JSON.stringify(error)));
      return {
        signature: '',
        positionAddress: '',
      };
    }
  }
}

export default function openPositionRoute(fastify: FastifyInstance, folderName: string): void {
  const controller = new OpenPositionController();

  fastify.post(`/${folderName}/open-position`, {
    schema: {
      tags: [folderName],
      description: 'Open a new Meteora position',
      body: Type.Object({
        baseSymbol: Type.String({ default: 'SOL' }),
        quoteSymbol: Type.String({ default: 'USDC' }),
        lowerPrice: Type.String({ default: '0.005' }),
        upperPrice: Type.String({ default: '0.02' }),
        poolAddress: Type.String({ default: '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6' }),
        quoteTokenAmount: Type.Number({ default: 1 }),
        baseTokenAmount: Type.Number({ default: 1 }),
        slippagePct: Type.Optional(Type.Number({ default: 1 })),
      }),
      response: {
        200: Type.Object({
          signature: Type.String(),
          positionMint: Type.String(),
          positionAddress: Type.String(),
        }),
      },
    },
    handler: async (request) => {
      const {
        baseSymbol,
        quoteSymbol,
        lowerPrice,
        upperPrice,
        poolAddress,
        quoteTokenAmount,
        baseTokenAmount,
        slippagePct,
      } = request.body as {
        baseSymbol: string;
        quoteSymbol: string;
        lowerPrice: string;
        upperPrice: string;
        poolAddress: string;
        quoteTokenAmount: number;
        baseTokenAmount: number;
        slippagePct?: number;
      };
      fastify.log.info(`Opening new Meteora position: ${baseSymbol}/${quoteSymbol}`);
      const result = await controller.openPosition(
        baseSymbol,
        quoteSymbol,
        new Decimal(lowerPrice),
        new Decimal(upperPrice),
        poolAddress,
        quoteTokenAmount,
        baseTokenAmount,
        slippagePct,
      );
      return result;
    },
  });
}
