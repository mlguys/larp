import { BN } from '@coral-xyz/anchor';
import { MeteoraController } from '../meteora.controller';
import DLMM, { LbPosition, PositionInfo } from '@meteora-ag/dlmm';
import { sendAndConfirmTransaction } from '@solana/web3.js';
import { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

export const RemoveLiquidityResponse = Type.Object({
  signature: Type.String(),
  liquidityBefore: Type.Object({
    tokenX: Type.String(),
    tokenY: Type.String()
  }),
  liquidityAfter: Type.Object({
    tokenX: Type.String(),
    tokenY: Type.String()
  })
});

class RemoveLiquidityController extends MeteoraController {
  async removeLiquidity(
    positionAddress: string,
    percentageToRemove: number,
  ): Promise<{ signature: string; liquidityBefore: { tokenX: string; tokenY: string }; liquidityAfter: { tokenX: string; tokenY: string } }> {
    // Find all positions by users
    const allPositions = await DLMM.getAllLbPairPositionsByUser(
      this.connection,
      this.keypair.publicKey,
    );

    // Find the matching position info
    let matchingLbPosition: LbPosition | undefined;
    let matchingPositionInfo: PositionInfo | undefined;

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

    // Initialize DLMM pool
    const dlmmPool = await DLMM.create(this.connection, matchingPositionInfo.publicKey);

    // Update pool state
    await dlmmPool.refetchStates();

    // Record before liquidity
    const beforeLiquidity = {
      tokenX: matchingLbPosition.positionData.totalXAmount.toString(),
      tokenY: matchingLbPosition.positionData.totalYAmount.toString()
    };

    // Calculate the amount of liquidity to remove
    const binIdsToRemove = matchingLbPosition.positionData.positionBinData.map(bin => bin.binId);
    const bps = new BN(percentageToRemove * 100);

    // Remove Liquidity
    const removeLiquidityTx = await dlmmPool.removeLiquidity({
      position: matchingLbPosition.publicKey,
      user: this.keypair.publicKey,
      binIds: binIdsToRemove,
      bps: bps,
      shouldClaimAndClose: false, // Set to true if you want to claim swap fee and close position
    });

    if (Array.isArray(removeLiquidityTx)) {
      throw new Error('Unexpected array of transactions. Expected a single transaction for removing liquidity.');
    }

    // prepare return object
    const returnObject = {
      signature: '',
      liquidityBefore: {
        tokenX: beforeLiquidity.tokenX,
        tokenY: beforeLiquidity.tokenY
      },
      liquidityAfter: {
        tokenX: '',
        tokenY: ''
      }
    } as typeof RemoveLiquidityResponse.static;

    try {
      const removeLiquidityTxHash = await sendAndConfirmTransaction(
        this.connection,
        removeLiquidityTx,
        [this.keypair],
        { skipPreflight: false, preflightCommitment: "confirmed" }
      );
      console.log('🚀 ~ removeLiquidityTxHash:', removeLiquidityTxHash);
      returnObject.signature = removeLiquidityTxHash;

      // Refresh the position data to get updated liquidity
      await dlmmPool.refetchStates();
      const positionsState = await dlmmPool.getPositionsByUserAndLbPair(
        this.keypair.publicKey
      );

      // Find the updated position in positionsState
      const updatedPosition = positionsState.userPositions.find(position => 
        position.publicKey.equals(matchingLbPosition.publicKey)
      );

      if (!updatedPosition) {
        throw new Error('Updated position not found after removing liquidity');
      }

      // Update the return object with the new liquidity amounts
      returnObject.liquidityAfter = {
        tokenX: updatedPosition.positionData.totalXAmount.toString(),
        tokenY: updatedPosition.positionData.totalYAmount.toString()
      };

      console.log('Liquidity removed successfully');
      console.log('Before:', returnObject.liquidityBefore);
      console.log('After:', returnObject.liquidityAfter);
    } catch (error) {
      console.error('Error removing liquidity:', error);
      throw error; // Re-throw the error to be handled by the route handler
    }

    return returnObject;
  }
}

export default function removeLiquidityRoute(fastify: FastifyInstance, folderName: string): void {
  const controller = new RemoveLiquidityController();

  fastify.post(`/${folderName}/remove-liquidity`, {
    schema: {
      tags: [folderName],
      description: 'Remove liquidity from a Meteora position',
      body: Type.Object({
        positionAddress: Type.String({ default: '' }),
        percentageToRemove: Type.Number({ minimum: 0, maximum: 100, default: 50 }),
      }),
      response: {
        200: RemoveLiquidityResponse
      }
    },
    handler: async (request, reply) => {
      const { positionAddress, percentageToRemove } = request.body as {
        positionAddress: string;
        percentageToRemove: number;
      };
      fastify.log.info(`Removing liquidity from Meteora position: ${positionAddress}`);
      try {
        const result = await controller.removeLiquidity(
          positionAddress,
          percentageToRemove,
        );
        return reply.send(result);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Internal Server Error' });
      }
    }
  });
}
