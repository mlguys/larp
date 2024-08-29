import { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler'
import { PublicKey } from '@solana/web3.js';
import { PriceMath, PoolUtil } from "@orca-so/whirlpools-sdk";
import { DecimalUtil } from "@orca-so/common-sdk";
import { OrcaController } from '../orca.controller';

export const PositionInfoSchema = Type.Object({
  position: Type.String(),
  whirlpoolAddress: Type.String(),
  whirlpoolPrice: Type.String(),
  tokenA: Type.String(),
  tokenB: Type.String(),
  liquidity: Type.String(),
  lower: Type.Object({
    tickIndex: Type.Number(),
    price: Type.String()
  }),
  upper: Type.Object({
    tickIndex: Type.Number(),
    price: Type.String()
  }),
  amountA: Type.String(),
  amountB: Type.String()
});

class GetPositionsController extends OrcaController {
  private positionInfoValidator = TypeCompiler.Compile(PositionInfoSchema);
  async getPositionInfo(positionAddress: string): Promise<string> {
    await this.loadOrca();

    const publicKey = new PublicKey(positionAddress);

    // Get the status of the position
    const position = await this.client.getPosition(publicKey);
    const data = position.getData();

    // Get the pool to which the position belongs
    const pool = await this.client.getPool(data.whirlpool);
    const token_a = pool.getTokenAInfo();
    const token_b = pool.getTokenBInfo();
    const price = PriceMath.sqrtPriceX64ToPrice(pool.getData().sqrtPrice, token_a.decimals, token_b.decimals);

    // Get the price range of the position
    const lower_price = PriceMath.tickIndexToPrice(data.tickLowerIndex, token_a.decimals, token_b.decimals);
    const upper_price = PriceMath.tickIndexToPrice(data.tickUpperIndex, token_a.decimals, token_b.decimals);

    // Calculate the amount of tokens that can be withdrawn from the position
    const amounts = PoolUtil.getTokenAmountsFromLiquidity(
      data.liquidity,
      pool.getData().sqrtPrice,
      PriceMath.tickIndexToSqrtPriceX64(data.tickLowerIndex),
      PriceMath.tickIndexToSqrtPriceX64(data.tickUpperIndex),
      true
    );

    const positionInfo = {
      position: publicKey.toBase58(),
      whirlpoolAddress: data.whirlpool.toBase58(),
      whirlpoolPrice: price.toFixed(token_b.decimals),
      tokenA: token_a.mint.toBase58(),
      tokenB: token_b.mint.toBase58(),
      liquidity: data.liquidity.toString(),
      lower: {
        tickIndex: data.tickLowerIndex,
        price: lower_price.toFixed(token_b.decimals)
      },
      upper: {
        tickIndex: data.tickUpperIndex,
        price: upper_price.toFixed(token_b.decimals)
      },
      amountA: DecimalUtil.fromBN(amounts.tokenA, token_a.decimals).toString(),
      amountB: DecimalUtil.fromBN(amounts.tokenB, token_b.decimals).toString()
    };

    // Validate the positionInfo object against the schema
    if (!this.positionInfoValidator.Check(positionInfo)) {
      throw new Error('Position info does not match the expected schema');
    }

    // Return the status of the position
    return JSON.stringify(positionInfo);
  }
}

export default function getPositionInfoRoute(fastify: FastifyInstance, folderName: string) {
  const controller = new GetPositionsController();

  fastify.get(`/${folderName}/position/:positionAddress`, {
    schema: {
      tags: [folderName],
      description: 'Retrieve info about an Orca position',
      params: Type.Object({
        positionAddress: Type.String()
      }),
      response: {
        200: PositionInfoSchema
      }
    },
    handler: async (request, reply) => {
      const { positionAddress } = request.params as { positionAddress: string };
      fastify.log.info(`Getting Orca positions for address: ${positionAddress}`);
      
      const positionInfo = await controller.getPositionInfo(positionAddress);
      return positionInfo;
    }
  });
}