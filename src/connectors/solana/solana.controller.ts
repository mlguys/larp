import {
  Connection,
  Keypair,
  clusterApiUrl,
  Cluster,
  Transaction,
  ComputeBudgetProgram,
  SignatureStatus,
  Signer,
} from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import { PublicKey } from '@solana/web3.js';
import { Type } from '@sinclair/typebox';
import { Client, UtlConfig, Token } from '@solflare-wallet/utl-sdk';
import { TokenInfoResponse } from './routes/listTokens';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { config } from 'dotenv';

interface RequestPayload {
  method: string;
  params: string[][];
  id: number;
  jsonrpc: string;
}

interface ResponseData {
  jsonrpc: string;
  result: Array<{
    prioritizationFee: number;
    slot: number;
  }>;
  id: number;
}

interface FeeEstimates {
  extreme: number;
  high: number;
  low: number;
  medium: number;
}

interface EstimatePriorityFeesParams {
  // The program account to use for fetching the local estimate (e.g., Jupiter: JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4)
  account?: string;
  // rcp URL
  endpoint: string;
}

// Update the TOKEN_LIST_FILE constant
const TOKEN_LIST_FILE =
  process.env.SOLANA_NETWORK === 'devnet'
    ? 'lists/devnet-tokenlist.json'
    : 'lists/solflare-tokenlist-20240912.json';

export const SolanaAddressSchema = Type.String({
  pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$',
  description: 'Solana address in base58 format',
});

export const BadRequestResponseSchema = Type.Object({
  statusCode: Type.Number(),
  error: Type.String(),
  message: Type.String(),
});

export type SolanaNetworkType = 'mainnet-beta' | 'devnet';

export class SolanaController {
  protected network: string;
  protected connection: Connection;
  protected keypair: Keypair | null = null;
  protected tokenList: any = null;
  private utl: Client;
  private tokenInfoValidator: ReturnType<typeof TypeCompiler.Compile>;
  private static solanaLogged: boolean = false;

  constructor() {
    this.network = this.validateSolanaNetwork(process.env.SOLANA_NETWORK);
    config(); // Load environment variables
    const rpcUrlOverride = process.env.SOLANA_RPC_URL_OVERRIDE;
    const rpcUrl =
      rpcUrlOverride && rpcUrlOverride.trim() !== ''
        ? rpcUrlOverride
        : clusterApiUrl(this.network as Cluster);

    this.connection = new Connection(rpcUrl, { commitment: 'confirmed' });

    this.loadWallet();
    this.loadTokenList();
    this.initializeUtl();
    this.tokenInfoValidator = TypeCompiler.Compile(TokenInfoResponse);

    // Log once only if the server is running
    if (!SolanaController.solanaLogged && process.env.START_SERVER === 'true') {
      console.log(`Solana connector initialized:
        - Network: ${this.network}
        - RPC URL: ${rpcUrl}
        - Wallet Public Key: ${this.keypair.publicKey.toBase58()}
        - Token List: ${TOKEN_LIST_FILE}
      `);
      SolanaController.solanaLogged = true;
    }
  }

  public validateSolanaNetwork(network: string | undefined): SolanaNetworkType {
    if (!network || (network !== 'mainnet-beta' && network !== 'devnet')) {
      throw new Error('Invalid SOLANA_NETWORK. Must be either "mainnet-beta" or "devnet"');
    }
    return network;
  }

  public validateSolanaAddress(address: string): boolean {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  protected loadWallet(): void {
    const walletPath = process.env.SOLANA_WALLET_JSON;
    if (!walletPath) {
      throw new Error('SOLANA_WALLET_JSON environment variable is not set');
    }
    try {
      const secretKeyArray = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
      this.keypair = Keypair.fromSecretKey(Uint8Array.from(secretKeyArray));
    } catch (error) {
      throw new Error(`Failed to load wallet JSON: ${error.message}`);
    }
  }

  protected loadTokenList(): void {
    const tokenListPath = path.join(__dirname, TOKEN_LIST_FILE);
    try {
      this.tokenList = JSON.parse(fs.readFileSync(tokenListPath, 'utf8'));
    } catch (error) {
      console.error(`Failed to load token list ${TOKEN_LIST_FILE}: ${error.message}`);
      this.tokenList = { content: [] };
    }
  }

  private initializeUtl(): void {
    const connectionUrl =
      this.network === 'devnet'
        ? 'https://api.devnet.solana.com'
        : 'https://api.mainnet-beta.solana.com';

    const config = new UtlConfig({
      chainId: this.network === 'devnet' ? 103 : 101,
      timeout: 2000,
      connection: this.connection,
      apiUrl: 'https://token-list-api.solana.cloud',
      cdnUrl: 'https://cdn.jsdelivr.net/gh/solflare-wallet/token-list/solana-tokenlist.json',
    });
    this.utl = new Client(config);
  }

  public getWallet(): { publicKey: string; network: string } {
    return {
      publicKey: this.keypair.publicKey.toBase58(),
      network: this.network,
    };
  }

  public getTokenList(): any {
    // Ensure the token list contains symbols
    return (
      this.tokenList.content.map((token) => ({
        address: token.address,
        chainId: token.chainId,
        name: token.name,
        symbol: token.symbol,
        decimals: token.decimals,
      })) || []
    );
  }

  public async getTokenByAddress(tokenAddress: string, useApi: boolean = false): Promise<Token> {
    if (useApi && this.network !== 'mainnet-beta') {
      throw new Error('API usage is only allowed on mainnet-beta');
    }

    const publicKey = new PublicKey(tokenAddress);
    let token: Token;

    if (useApi) {
      token = await this.utl.fetchMint(publicKey);
    } else {
      const tokenList = this.getTokenList();
      const foundToken = tokenList.find((t) => t.address === tokenAddress);
      if (!foundToken) {
        throw new Error('Token not found in the token list');
      }
      token = foundToken as Token;
    }

    // Validate the token object against the schema
    if (!this.tokenInfoValidator.Check(token)) {
      throw new Error('Token info does not match the expected schema');
    }

    return token;
  }

  public async getTokenBySymbol(symbol: string): Promise<Token> {
    const tokenList = this.getTokenList();
    const foundToken = tokenList.find((t) => t.symbol.toLowerCase() === symbol.toLowerCase());

    if (!foundToken) {
      throw new Error('Token not found in the token list');
    }

    // Validate the token object against the schema
    if (!this.tokenInfoValidator.Check(foundToken)) {
      throw new Error('Token info does not match the expected schema');
    }

    return foundToken as Token;
  }

  async fetchEstimatePriorityFees({
    account,
    endpoint,
  }: EstimatePriorityFeesParams): Promise<FeeEstimates> {
    const DEFAULT_FEES = { low: 10000, medium: 20000, high: 30000, extreme: 40000 };

    try {
      // Only include params that are defined
      const params: string[][] = [];
      if (account !== undefined) {
        // Add accounts from https://triton.one/solana-prioritization-fees/ to track general fees
        params.push(['GASeo1wEK3rWwep6fsAt212Jw9zAYguDY5qUwTnyZ4RH']);
      }

      const payload: RequestPayload = {
        method: 'getRecentPrioritizationFees',
        params: params,
        id: 1,
        jsonrpc: '2.0',
      };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        console.error(`HTTP error! status: ${response.status}`);
        return DEFAULT_FEES;
      }

      const data: ResponseData = await response.json();

      // Process the response to categorize fees
      const fees = data.result.map((item) => item.prioritizationFee);

      // Filter out zero fees for calculations
      const nonZeroFees = fees.filter((fee) => fee > 0);
      nonZeroFees.sort((a, b) => a - b); // Sort non-zero fees in ascending order

      let { low, medium, high, extreme } = DEFAULT_FEES;

      if (nonZeroFees.length > 0) {
        const maxFee = nonZeroFees[nonZeroFees.length - 1];
        low = Math.max(Math.floor(maxFee * 0.25), low);
        medium = Math.max(Math.floor(maxFee * 0.5), medium);
        high = Math.max(Math.floor(maxFee * 0.75), high);
        extreme = Math.max(Math.floor(maxFee), extreme);
      }

      return {
        low,
        medium,
        high,
        extreme,
      };
    } catch (error) {
      console.error(
        `Return fallback fees as failed to fetch estimate priority fees: ${error.message}`,
      );
      return DEFAULT_FEES;
    }
  }

  public async confirmTransaction(signature: string): Promise<boolean> {
    try {
      const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignatureStatuses',
        params: [
          [signature],
          {
            searchTransactionHistory: true,
          },
        ],
      };

      const response = await fetch(this.connection.rpcEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      if (data.result && data.result.value && data.result.value[0]) {
        const status: SignatureStatus = data.result.value[0];
        if (status.err !== null) {
          throw new Error(`Transaction failed with error: ${JSON.stringify(status.err)}`);
        }
        const isConfirmed =
          status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized';
        return isConfirmed;
      }

      return false;
    } catch (error) {
      console.error('Error confirming transaction:', error.message);
      throw new Error(`Failed to confirm transaction: ${error.message}`);
    }
  }

  public async confirmTransactionByAddress(address: string, signature: string): Promise<boolean> {
    try {
      const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: [
          address,
          {
            limit: 100, // Adjust the limit as needed
            until: signature,
          },
        ],
      };

      const response = await fetch(this.connection.rpcEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      if (data.result) {
        const transactionInfo = data.result.find((entry) => entry.signature === signature);

        if (!transactionInfo) {
          return false;
        }

        if (transactionInfo.err !== null) {
          throw new Error(`Transaction failed with error: ${JSON.stringify(transactionInfo.err)}`);
        }

        const isConfirmed =
          transactionInfo.confirmationStatus === 'confirmed' ||
          transactionInfo.confirmationStatus === 'finalized';
        return isConfirmed;
      }

      return false;
    } catch (error) {
      console.error('Error confirming transaction using signatures:', error.message);
      throw new Error(`Failed to confirm transaction using signatures: ${error.message}`);
    }
  }

  async sendAndConfirmTransaction(
    tx: Transaction,
    signers: Signer[] = [],
    accountToGetPriorityFees: string,
  ): Promise<string> {
    const priorityFeesEstimate = await this.fetchEstimatePriorityFees({
      account: accountToGetPriorityFees,
      endpoint: this.connection.rpcEndpoint,
    });

    const priorityFeeInstruction = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityFeesEstimate.high,
    });

    tx.instructions.push(priorityFeeInstruction);

    let blockheight = await this.connection.getBlockHeight();

    const lastValidBlockHeight = blockheight + 100; // Make sure the transaction not taking too much time
    tx.lastValidBlockHeight = lastValidBlockHeight;

    let signature: string;

    while (blockheight < lastValidBlockHeight) {
      tx.sign(...signers);

      signature = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
      });

      // Sleep for 500ms
      await new Promise((resolve) => setTimeout(resolve, 500));

      if (
        (await this.confirmTransaction(signature)) ||
        (await this.confirmTransactionByAddress(signers[0].publicKey.toBase58(), signature))
      ) {
        return signature;
      }

      blockheight = await this.connection.getBlockHeight();
    }

    // Check if the transaction has been confirmed after exiting the loop
    if (
      !(await this.confirmTransaction(signature)) &&
      !(await this.confirmTransactionByAddress(signers[0].publicKey.toBase58(), signature))
    ) {
      console.error('Transaction could not be confirmed within the valid block height range.');
      throw new Error('Transaction could not be confirmed within the valid block height range');
    }
    return signature;
  }
}
