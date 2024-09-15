import { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler'
import DLMM, { LbPosition, PositionInfo } from '@meteora-ag/dlmm';
import { MeteoraController } from '../meteora.controller';
import { sendAndConfirmTransaction } from '@solana/web3.js';

const CollectFeesResponse = Type.Object({
  signature: Type.String(),
});

class CollectFeesController extends MeteoraController {
  private collectFeesResponseValidator = TypeCompiler.Compile(CollectFeesResponse);

  async collectFees(positionAddress: string): Promise<string> {
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

    // Claim swap fees
    const claimSwapFeeTx = await dlmmPool.claimSwapFee({
      owner: this.keypair.publicKey,
      position: matchingLbPosition,
    });

    let signature: string;
    try {
      signature = await sendAndConfirmTransaction(
        this.connection,
        claimSwapFeeTx,
        [this.keypair],
        { skipPreflight: false, preflightCommitment: "confirmed" }
      );
      console.log('🚀 ~ claimSwapFeeTxHash:', signature);
      console.log('Fees collected successfully');
    } catch (error) {
      console.error('Error collecting fees:', error);
      throw error;
    }

    const response = { signature };

    // Validate the response object against the schema
    if (!this.collectFeesResponseValidator.Check(response)) {
      throw new Error('Collect fees response does not match the expected schema');
    }

    return JSON.stringify(response);
  }
}

export default function collectFeesRoute(fastify: FastifyInstance, folderName: string) {
  const controller = new CollectFeesController();

  fastify.post(`/${folderName}/collect-fees/:positionAddress`, {
    schema: {
      tags: [folderName],
      description: 'Collect fees for a Meteora position',
      params: Type.Object({
        positionAddress: Type.String(),
      }),
      response: {
        200: CollectFeesResponse
      },
    },
    handler: async (request) => {
      const { positionAddress } = request.params as { positionAddress: string };
      fastify.log.info(`Collecting fees for Meteora position: ${positionAddress}`);
      const result = await controller.collectFees(positionAddress);
      return JSON.parse(result);
    }
  });
}
