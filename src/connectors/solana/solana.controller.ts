import { Connection, Keypair, clusterApiUrl, Cluster } from '@solana/web3.js';
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
  params: {
    last_n_blocks: number;
    account: string;
  };
  id: number;
  jsonrpc: string;
}

interface FeeEstimates {
  extreme: number;
  high: number;
  low: number;
  medium: number;
  percentiles: {
    [key: string]: number;
  };
}

interface ResponseData {
  jsonrpc: string;
  result: {
    context: {
      slot: number;
    };
    per_compute_unit: FeeEstimates;
    per_transaction: FeeEstimates;
  };
  id: number;
}

interface EstimatePriorityFeesParams {
  // The number of blocks to consider for the fee estimate
  last_n_blocks?: number;
  // The program account to use for fetching the local estimate (e.g., Jupiter: JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4)
  account?: string;
  // Your Add-on Endpoint (found in your QuickNode Dashboard - https://dashboard.quicknode.com/endpoints)
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

    this.connection = new Connection(rpcUrl);

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

  // This function is exclusive to quicknode node
  // Source: https://www.quicknode.com/guides/solana-development/transactions/how-to-use-priority-fees
  async fetchEstimatePriorityFees({
    last_n_blocks,
    account,
    endpoint,
  }: EstimatePriorityFeesParams): Promise<ResponseData> {
    // Only include params that are defined
    const params: any = {};
    if (last_n_blocks !== undefined) {
      params.last_n_blocks = last_n_blocks;
    }
    if (account !== undefined) {
      params.account = account;
    }

    const payload: RequestPayload = {
      method: 'qn_estimatePriorityFees',
      params,
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
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data: ResponseData = await response.json();
    return data;
  }
}
