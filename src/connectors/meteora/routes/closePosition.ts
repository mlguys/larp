import { MeteoraController } from '../meteora.controller';
import DLMM, { LbPosition, PositionInfo } from '@meteora-ag/dlmm';
import { Cluster, ComputeBudgetProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

export const ClosePositionResponse = Type.Object({
  signature: Type.String(),
});

class ClosePositionController extends MeteoraController {
  async closePosition(positionAddress: string): Promise<{ signature: string }> {
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

    // Initialize DLMM pool
    const dlmmPool = await DLMM.create(this.connection, matchingPositionInfo.publicKey, {
      cluster: this.network as Cluster,
    });

    // Update pool state
    await dlmmPool.refetchStates();

    // Get priority fees
    const { result: priorityFeesEstimate } = await this.fetchEstimatePriorityFees({
      last_n_blocks: 100,
      account: matchingPositionInfo.publicKey.toBase58(),
      endpoint: this.connection.rpcEndpoint,
    });

    const priorityFeeInstruction = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityFeesEstimate.per_compute_unit.high,
    });

    // Close Position
    const closePositionTx = await dlmmPool.closePosition({
      owner: this.keypair.publicKey,
      position: matchingLbPosition,
    });

    closePositionTx.instructions.push(priorityFeeInstruction);

    // prepare return object
    const returnObject = {
      signature: '',
    } as typeof ClosePositionResponse.static;

    try {
      const closePositionTxHash = await sendAndConfirmTransaction(
        this.connection,
        closePositionTx,
        [this.keypair],
        { skipPreflight: false, preflightCommitment: 'confirmed', commitment: 'confirmed' },
      );
      console.log('🚀 ~ closePositionTxHash:', closePositionTxHash);
      returnObject.signature = closePositionTxHash;

      console.log('Position closed successfully');
    } catch (error) {
      console.error('Error closing position:', error);
      throw error; // Re-throw the error to be handled by the caller
    }

    return returnObject;
  }
}

export default function closePositionRoute(fastify: FastifyInstance, folderName: string): void {
  const controller = new ClosePositionController();

  fastify.post(`/${folderName}/close-position`, {
    schema: {
      tags: [folderName],
      description: 'Close a Meteora position',
      body: Type.Object({
        positionAddress: Type.String({ default: '' }),
      }),
      response: {
        200: ClosePositionResponse,
      },
    },
    handler: async (request) => {
      const { positionAddress } = request.body as {
        positionAddress: string;
      };
      fastify.log.info(`Closing Meteora position: ${positionAddress}`);
      const result = await controller.closePosition(positionAddress);
      return result;
    },
  });
}
