import type { Address, Hex } from "viem";

// ---------------------------------------------------------------------------
// Relay API types
// ---------------------------------------------------------------------------

/** POST /execute request body */
export interface ExecuteGaslessRequest {
  executionKind: "rawCalls";
  data: {
    chainId: number;
    to: string;
    data: string;
    value: string;
    authorizationList: SignedAuthorization[];
  };
  executionOptions: {
    referrer: string;
    subsidizeFees: boolean;
    destinationChainExecutionData?: {
      calls: Array<{ to: string; data: string; value: string }>;
      authorizationList?: SignedAuthorization[];
    };
  };
  /** Include when this is a cross-chain request (from a prior /quote call) */
  requestId?: string;
}

export interface SignedAuthorization {
  chainId: number;
  address: string;
  nonce: number;
  yParity: number;
  r: string;
  s: string;
}

/** POST /execute response */
export interface ExecuteGaslessResponse {
  message: string;
  requestId: string;
}

/** Fee currency object from /quote response */
export interface CurrencyObject {
  currency: {
    chainId: number;
    address: string;
    symbol: string;
    name: string;
    decimals: number;
  };
  amount: string;
  amountFormatted: string;
  amountUsd: string;
}

/** POST /quote response (subset of fields we use) */
export interface QuoteResponse {
  requestId?: string;
  steps: Array<{
    id: string;
    action: string;
    description: string;
    kind: "transaction" | "signature";
    items: Array<{
      status: string;
      data: {
        from: Address;
        to: Address;
        data: Hex;
        value: string;
        chainId: number;
      };
    }>;
  }>;
  fees: {
    gas: CurrencyObject;
    relayer: CurrencyObject;
    relayerGas: CurrencyObject;
    relayerService: CurrencyObject;
    app: CurrencyObject;
    subsidized: CurrencyObject;
  };
  details: {
    operation: string;
    timeEstimate: number;
    sender: string;
    recipient: string;
    currencyIn: CurrencyObject;
    currencyOut: CurrencyObject;
  };
}

/** GET /intents/status/v3 response */
export interface StatusResponse {
  status:
    | "waiting"
    | "pending"
    | "submitted"
    | "success"
    | "failure"
    | "refund";
  inTxHashes?: string[];
  txHashes?: string[];
}
