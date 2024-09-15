import { BN } from '@coral-xyz/anchor';
import { MeteoraController } from '../meteora.controller';
import DLMM, { LbPosition, StrategyType } from '@meteora-ag/dlmm';
import { sendAndConfirmTransaction } from '@solana/web3.js';
import { FastifyInstance } from 'fastify';
import { MAX_ACTIVE_BIN_SLIPPAGE, PositionInfo } from '@meteora-ag/dlmm';
import { Type } from '@sinclair/typebox';

export const AddLiquidityResponse = Type.Object({
  signature: Type.String(),
  liquidityBefore: Type.Object({
    tokenX: Type.String(),
    tokenY: Type.String(),
  }),
  liquidityAfter: Type.Object({
    tokenX: Type.String(),
    tokenY: Type.String(),
  }),
});

class AddLiquidityController extends MeteoraController {
  async addLiquidity(
    positionAddress: string,
    baseTokenAmount: number,
    quoteTokenAmount: number,
    slippagePct?: number,
  ): Promise<{
    signature: string;
    liquidityBefore: { tokenX: string; tokenY: string };
    liquidityAfter: { tokenX: string; tokenY: string };
  }> {
    // Find all positions by users
    const allPositions = await DLMM.getAllLbPairPositionsByUser(
      this.connection,
      this.keypair.publicKey,
    );

    // Find the matching position info
    let matchingLbPosition: LbPosition;
    let matchingPositionInfo: PositionInfo;

    for (const position of allPositions.values()) {
      matchingLbPosition = position.lbPairPositionsData.find(
        (lbPosition) => lbPosition.publicKey.toBase58() === positionAddress,
      );
      if (matchingLbPosition) {
        matchingPositionInfo = position;
        break;
      }
    }

    if (!matchingLbPosition || !matchingPositionInfo) {
      throw new Error('Position not found');
    }

    // Get requirement data
    const maxBinId = matchingLbPosition.positionData.upperBinId;
    const minBinId = matchingLbPosition.positionData.lowerBinId;
    const totalXAmount = new BN(baseTokenAmount);
    const totalYAmount = new BN(quoteTokenAmount);

    // Initialize DLMM pool
    const dlmmPool = await DLMM.create(this.connection, matchingPositionInfo.publicKey);

    // Update pool state
    await dlmmPool.refetchStates();

    // Record before liquidity
    const beforeLiquidity = {
      tokenX: matchingLbPosition.positionData.totalXAmount.toString(),
      tokenY: matchingLbPosition.positionData.totalYAmount.toString(),
    };

    // Add Liquidity to existing position
    const addLiquidityTx = await dlmmPool.addLiquidityByStrategy({
      positionPubKey: matchingLbPosition.publicKey,
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

    // prepare return object
    const returnObject = {
      signature: '',
      liquidityBefore: {
        tokenX: beforeLiquidity.tokenX,
        tokenY: beforeLiquidity.tokenY,
      },
      liquidityAfter: {
        tokenX: '',
        tokenY: '',
      },
    } as typeof AddLiquidityResponse.static;

    try {
      const addLiquidityTxHash = await sendAndConfirmTransaction(this.connection, addLiquidityTx, [
        this.keypair,
      ]);
      console.log('🚀 ~ addLiquidityTxHash:', addLiquidityTxHash);
      returnObject.signature = addLiquidityTxHash;

      // Refresh the position data to get updated liquidity
      await dlmmPool.refetchStates();
      const positionsState = await dlmmPool.getPositionsByUserAndLbPair(this.keypair.publicKey);

      // Find the updated position in positionsState
      const updatedPosition = positionsState.userPositions.find((position) =>
        position.publicKey.equals(matchingLbPosition.publicKey),
      );

      if (!updatedPosition) {
        throw new Error('Updated position not found after adding liquidity');
      }

      // Update the return object with the new liquidity amounts
      returnObject.liquidityAfter = {
        tokenX: updatedPosition.positionData.totalXAmount.toString(),
        tokenY: updatedPosition.positionData.totalYAmount.toString(),
      };

      console.log('Liquidity added successfully');
      console.log('Before:', returnObject.liquidityBefore);
      console.log('After:', returnObject.liquidityAfter);
    } catch (error) {
      console.error('Error adding liquidity:', error);
      throw error; // Re-throw the error to be handled by the caller
    }

    return returnObject;
  }
}

export default function addLiquidityRoute(fastify: FastifyInstance, folderName: string): void {
  const controller = new AddLiquidityController();

  fastify.post(`/${folderName}/add-liquidity`, {
    schema: {
      tags: [folderName],
      description: 'Add liquidity to a Meteora position',
      body: Type.Object({
        positionAddress: Type.String({ default: '' }),
        baseTokenAmount: Type.Number({ default: 1 }),
        quoteTokenAmount: Type.Number({ default: 1 }),
        slippagePct: Type.Optional(Type.Number({ default: 1 })),
      }),
      response: {
        200: AddLiquidityResponse,
      },
    },
    handler: async (request, reply) => {
      const { positionAddress, baseTokenAmount, quoteTokenAmount, slippagePct } = request.body as {
        positionAddress: string;
        baseTokenAmount: number;
        quoteTokenAmount: number;
        slippagePct?: number;
      };
      fastify.log.info(`Adding liquidity to Meteora position: ${positionAddress}`);
      try {
        const result = await controller.addLiquidity(
          positionAddress,
          baseTokenAmount,
          quoteTokenAmount,
          slippagePct,
        );
        return result;
      } catch (error) {
        fastify.log.error(`Error adding liquidity: ${error.message}`);
        reply.status(500).send({ error: 'Failed to add liquidity' });
      }
    },
  });
}
