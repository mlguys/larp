import { MeteoraController } from '../meteora.controller';
import DLMM from '@meteora-ag/dlmm';
import {
  Cluster,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

class OpenPositionController extends MeteoraController {
  async openPosition(
    baseSymbol: string,
    quoteSymbol: string,
    lowerPrice: number,
    upperPrice: number,
    poolAddress: string,
  ): Promise<{ signature: string; positionAddress: string }> {
    // TODO: if no pool address is provided => find pool by symbol
    const newImbalancePosition = new Keypair();
    const dlmmPoolPubkey = new PublicKey(poolAddress);
    const dlmmPool = await DLMM.create(this.connection, dlmmPoolPubkey, {
      cluster: this.network as Cluster,
    });

    // Update pool state
    await dlmmPool.refetchStates();

    const lowerPricePerLamport = dlmmPool.toPricePerLamport(lowerPrice);
    const upperPricePerLamport = dlmmPool.toPricePerLamport(upperPrice);

    const minBinId = dlmmPool.getBinIdFromPrice(Number(lowerPricePerLamport), true) - 1;
    console.log('Debug: minBinId:', minBinId);

    const maxBinId = dlmmPool.getBinIdFromPrice(Number(upperPricePerLamport), false) + 1;
    console.log('Debug: maxBinId:', maxBinId);

    // Get priority fees
    const { result: priorityFeesEstimate } = await this.fetchEstimatePriorityFees({
      last_n_blocks: 100,
      account: poolAddress,
      endpoint: this.connection.rpcEndpoint,
    });

    const priorityFeeInstruction = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityFeesEstimate.per_compute_unit.high,
    });

    // Create Position
    const createPositionTx = await dlmmPool.createEmptyPosition({
      positionPubKey: newImbalancePosition.publicKey,
      user: this.keypair.publicKey,
      maxBinId,
      minBinId,
    });

    createPositionTx.instructions.push(priorityFeeInstruction);

    try {
      const createImbalancePositionTxHash = await sendAndConfirmTransaction(
        this.connection,
        createPositionTx,
        [this.keypair, newImbalancePosition],
        { commitment: 'confirmed' },
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
        lowerPrice: Type.Number({ default: 120 }),
        upperPrice: Type.Number({ default: 130 }),
        poolAddress: Type.String({ default: '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6' }),
      }),
      response: {
        200: Type.Object({
          signature: Type.String(),
          positionAddress: Type.String(),
        }),
      },
    },
    handler: async (request) => {
      const { baseSymbol, quoteSymbol, lowerPrice, upperPrice, poolAddress } = request.body as {
        baseSymbol: string;
        quoteSymbol: string;
        lowerPrice: number;
        upperPrice: number;
        poolAddress: string;
      };
      fastify.log.info(`Opening new Meteora position: ${baseSymbol}/${quoteSymbol}`);
      const result = await controller.openPosition(
        baseSymbol,
        quoteSymbol,
        lowerPrice,
        upperPrice,
        poolAddress,
      );
      return result;
    },
  });
}
