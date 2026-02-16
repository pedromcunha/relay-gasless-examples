/**
 * Full Subsidy EOA Example — True Gasless with /execute
 * =====================================================
 * Use case: BYO Wallet + EIP-7702 + Full Fee Subsidization
 *
 * The app covers ALL fees including origin gas:
 *   - Origin chain gas     → sponsor wallet submits the tx
 *   - Destination chain gas → sponsor covers via subsidizeFees
 *   - Relayer service fee   → sponsor covers via subsidizeFees
 *   - App fees              → waived / absorbed by app
 *
 * The user never needs native tokens. They sign an EIP-7702
 * authorization (off-chain), and the sponsor's relayer submits
 * and pays for the origin tx on their behalf.
 *
 * Flow:
 *   0. Check/setup EIP-7702 delegation on user's EOA
 *   1. POST /quote    → get requestId + deposit tx details
 *   2. User signs EIP-7702 authorization for the deposit tx
 *   3. POST /execute  → sponsor submits the signed tx (gasless)
 *   4. Poll status    → wait for destination chain execution
 *
 * Requirements:
 *   - An API key with a funded sponsoringWalletAddress
 *   - The user's wallet (EOA) for signing only — no gas needed
 *   - EIP-7702 support on the origin chain (post-Pectra)
 */

import "dotenv/config";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseEther,
  formatEther,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, arbitrum } from "viem/chains";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RELAY_API = process.env.RELAY_API_URL || "https://api.relay.link";
const RELAY_API_KEY = process.env.RELAY_API_KEY || "";
const DRY_RUN = process.env.DRY_RUN === "true";

// User's existing EOA — in production this comes from the user's connected
// wallet (MetaMask, Rainbow, etc). Here we use a test key for demo purposes.
const USER_PRIVATE_KEY = process.env.USER_PRIVATE_KEY as Hex | undefined;

// Bridge: ETH on Arbitrum → ETH on Base
const ORIGIN_CHAIN_ID = arbitrum.id; // 42161
const DESTINATION_CHAIN_ID = base.id; // 8453
const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";
const BRIDGE_AMOUNT = parseEther("0.001"); // 0.001 ETH for testing

// ---------------------------------------------------------------------------
// Relay contract addresses
// ---------------------------------------------------------------------------
// The erc20Router is the contract the user's EOA delegates to via EIP-7702.
// It has a `delegatecallMulticall` function that lets the solver execute
// deposit logic in the context of the user's EOA.
//
// These are the active v2 addresses — same across all major EVM chains.
// In production, fetch these from the Relay API or your own config.
// ---------------------------------------------------------------------------

const RELAY_ERC20_ROUTER: Record<number, Address> = {
  [1]: "0xf5042e6ffac5a625d4e7848e0b01373d8eb9e222", // Ethereum
  [10]: "0xf5042e6ffac5a625d4e7848e0b01373d8eb9e222", // Optimism
  [8453]: "0xf5042e6ffac5a625d4e7848e0b01373d8eb9e222", // Base
  [42161]: "0xf5042e6ffac5a625d4e7848e0b01373d8eb9e222", // Arbitrum
};

// EIP-7702 delegation prefix: code stored at the EOA starts with 0xef0100
// followed by the 20-byte delegate address.
const EIP7702_DELEGATION_PREFIX = "0xef0100";

// ---------------------------------------------------------------------------
// Types (matching the solver's /execute endpoint exactly)
// ---------------------------------------------------------------------------

/** POST /execute request body */
interface ExecuteGaslessRequest {
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

interface SignedAuthorization {
  chainId: number;
  address: string;
  nonce: number;
  yParity: number;
  r: string;
  s: string;
}

/** POST /execute response */
interface ExecuteGaslessResponse {
  message: string;
  requestId: string;
}

/** Fee currency object from /quote response */
interface CurrencyObject {
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
interface QuoteResponse {
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
interface StatusResponse {
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

// ---------------------------------------------------------------------------
// Step 0: Check / setup EIP-7702 delegation on the user's EOA
// ---------------------------------------------------------------------------

async function checkAndSetupDelegation(
  userAddress: Address,
  chainId: number
): Promise<{ isDelegated: boolean; delegateAddress: Address }> {
  console.log("\n━━━ Step 0: Check EIP-7702 delegation ━━━\n");

  const delegateAddress = RELAY_ERC20_ROUTER[chainId];
  if (!delegateAddress) {
    throw new Error(
      `No Relay erc20Router address configured for chain ${chainId}. ` +
        `Add it to RELAY_ERC20_ROUTER.`
    );
  }

  console.log(`  EOA:              ${userAddress}`);
  console.log(`  Chain:            ${chainId}`);
  console.log(`  Relay erc20Router: ${delegateAddress}\n`);

  // ┌───────────────────────────────────────────────────────────────┐
  // │  EIP-7702 DELEGATION CHECK                                   │
  // │                                                               │
  // │  When an EOA is delegated via 7702, its on-chain code is set │
  // │  to: 0xef0100 + <20-byte delegate address>                   │
  // │                                                               │
  // │  We check getCode(eoa) to see if:                            │
  // │    1. The EOA has no delegation (code = "0x")                 │
  // │    2. The EOA is already delegated to the Relay router        │
  // │    3. The EOA is delegated to something else (needs re-auth)  │
  // │                                                               │
  // │  THIS IS THE APP DEVELOPER'S RESPONSIBILITY.                  │
  // │  Relay does not handle delegation setup — your app must       │
  // │  check and request the user's 7702 authorization.             │
  // └───────────────────────────────────────────────────────────────┘

  if (DRY_RUN && !USER_PRIVATE_KEY) {
    console.log("  [DRY RUN] Skipping on-chain delegation check.\n");
    console.log("  In production, call getCode(eoaAddress) to check if the");
    console.log("  EOA is already delegated to the Relay erc20Router.\n");
    return { isDelegated: false, delegateAddress };
  }

  const publicClient = createPublicClient({
    chain: arbitrum,
    transport: http(),
  });

  const code = await publicClient.getCode({ address: userAddress });

  if (!code || code === "0x") {
    // No delegation — the user's EOA is a plain EOA.
    // We'll need them to sign a 7702 authorization in Step 2.
    console.log("  Status: NOT delegated (plain EOA)");
    console.log("  → User will need to sign a 7702 authorization.\n");
    return { isDelegated: false, delegateAddress };
  }

  if (code.toLowerCase().startsWith(EIP7702_DELEGATION_PREFIX)) {
    // EOA has a 7702 delegation — check if it's to the Relay router
    const currentDelegate = ("0x" +
      code.slice(EIP7702_DELEGATION_PREFIX.length)) as Address;

    if (currentDelegate.toLowerCase() === delegateAddress.toLowerCase()) {
      console.log("  Status: ✓ Already delegated to Relay erc20Router");
      console.log(`  Delegate: ${currentDelegate}\n`);
      return { isDelegated: true, delegateAddress };
    } else {
      // Delegated to a different contract — need to re-authorize
      console.log(`  Status: Delegated to a DIFFERENT contract`);
      console.log(`  Current:  ${currentDelegate}`);
      console.log(`  Expected: ${delegateAddress}`);
      console.log("  → User will need to sign a new 7702 authorization.\n");
      return { isDelegated: false, delegateAddress };
    }
  }

  // The EOA has contract code but it's not a 7702 delegation.
  // This means it's actually a contract (e.g., a 4337 smart wallet).
  // The 7702 flow doesn't apply — this example is for plain EOAs.
  throw new Error(
    `Address ${userAddress} has non-7702 contract code. ` +
      `This is likely a smart contract wallet, not an EOA. ` +
      `Use the EIP-4337 flow instead.`
  );
}

// ---------------------------------------------------------------------------
// Step 1: Get a subsidized quote (to get the requestId and deposit tx data)
// ---------------------------------------------------------------------------

async function getSubsidizedQuote(
  userAddress: Address
): Promise<QuoteResponse> {
  console.log("\n━━━ Step 1: Get subsidized quote ━━━\n");
  console.log(`  Origin:      Arbitrum (${ORIGIN_CHAIN_ID})`);
  console.log(`  Destination: Base (${DESTINATION_CHAIN_ID})`);
  console.log(`  Amount:      ${formatEther(BRIDGE_AMOUNT)} ETH`);
  console.log(`  User:        ${userAddress}`);
  console.log(`  Subsidized:  true (app pays ALL fees)\n`);

  const res = await fetch(`${RELAY_API}/quote`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(RELAY_API_KEY ? { Authorization: `Bearer ${RELAY_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      user: userAddress,
      originChainId: ORIGIN_CHAIN_ID,
      destinationChainId: DESTINATION_CHAIN_ID,
      originCurrency: NATIVE_TOKEN,
      destinationCurrency: NATIVE_TOKEN,
      amount: BRIDGE_AMOUNT.toString(),
      tradeType: "EXACT_INPUT",
      recipient: userAddress,
      subsidizeFees: true,
      maxSubsidizationAmount: "5000000", // $5 cap per tx
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Quote failed (${res.status}): ${error}`);
  }

  const quote: QuoteResponse = await res.json();
  printFeeBreakdown(quote);
  return quote;
}

// ---------------------------------------------------------------------------
// Step 2: User signs EIP-7702 authorization (off-chain, no gas needed)
// ---------------------------------------------------------------------------

async function signAuthorization(
  quote: QuoteResponse,
  delegateAddress: Address,
  isDelegated: boolean,
  userAddress: Address
): Promise<{
  depositTx: QuoteResponse["steps"][0]["items"][0]["data"];
  authorization: SignedAuthorization;
} | null> {
  console.log("\n━━━ Step 2: Sign EIP-7702 authorization ━━━\n");

  // Extract the deposit transaction from the quote steps.
  // This is the tx the user would normally submit + pay gas for.
  // With gasless, the sponsor submits it on their behalf.
  const txStep = quote.steps?.find((s) => s.kind === "transaction");
  const depositTx = txStep?.items?.[0]?.data;

  if (!depositTx) {
    console.log("  ⚠ No transaction step found in quote — nothing to sign.\n");
    return null;
  }

  console.log(`  Deposit tx target: ${depositTx.to}`);
  console.log(`  Deposit tx value:  ${depositTx.value} wei`);
  console.log(`  Chain:             ${depositTx.chainId}`);
  console.log(`  Delegate contract: ${delegateAddress}`);
  console.log(`  Already delegated: ${isDelegated}\n`);

  // ┌───────────────────────────────────────────────────────────────┐
  // │  AUTHORIZATION TARGET                                         │
  // │                                                               │
  // │  The 7702 authorization delegates the user's EOA to the       │
  // │  Relay erc20Router — NOT to the deposit tx target.            │
  // │                                                               │
  // │  The erc20Router has a `delegatecallMulticall` function that  │
  // │  lets the solver execute deposit logic in the context of the  │
  // │  user's EOA (i.e., the user's EOA temporarily "becomes" the  │
  // │  router and can approve + transfer tokens).                   │
  // │                                                               │
  // │  If the EOA is already delegated to the Relay router, we can │
  // │  skip the authorization step — the solver can already execute │
  // │  on behalf of this EOA.                                       │
  // └───────────────────────────────────────────────────────────────┘

  if (isDelegated) {
    console.log("  ✓ EOA already delegated — skipping authorization.\n");
    // Still need to return the deposit tx for the /execute call,
    // but with an empty authorization list since the delegation persists.
    return {
      depositTx,
      authorization: {
        chainId: depositTx.chainId,
        address: delegateAddress,
        nonce: 0,
        yParity: 0,
        r: "0x0000000000000000000000000000000000000000000000000000000000000000",
        s: "0x0000000000000000000000000000000000000000000000000000000000000000",
      },
    };
  }

  if (!USER_PRIVATE_KEY) {
    console.log("  [SKIP] No USER_PRIVATE_KEY set.");
    console.log("  In production, use wallet_sendCalls (ERC-5792) or");
    console.log("  wallet.signAuthorization() from the connected wallet.\n");

    // Return a mock authorization for the dry run
    return {
      depositTx,
      authorization: {
        chainId: depositTx.chainId,
        address: delegateAddress,
        nonce: 0,
        yParity: 0,
        r: "0x0000000000000000000000000000000000000000000000000000000000000000",
        s: "0x0000000000000000000000000000000000000000000000000000000000000000",
      },
    };
  }

  // Sign the 7702 authorization — this is gasless, just a signature.
  // It temporarily sets the user's EOA code to the Relay erc20Router,
  // enabling the solver to execute the deposit via delegatecallMulticall.
  const account = privateKeyToAccount(USER_PRIVATE_KEY);
  const walletClient = createWalletClient({
    account,
    chain: arbitrum,
    transport: http(),
  });

  console.log(
    `  Signing 7702 authorization to delegate EOA → ${delegateAddress}...`
  );

  const publicClient = createPublicClient({
    chain: arbitrum,
    transport: http(),
  });
  const currentNonce = await publicClient.getTransactionCount({
    address: userAddress,
  });

  const signedAuth = await walletClient.signAuthorization({
    contractAddress: delegateAddress,
    chainId: depositTx.chainId,
    nonce: currentNonce,
  });

  const authorization: SignedAuthorization = {
    chainId: Number(signedAuth.chainId),
    address: signedAuth.address,
    nonce: signedAuth.nonce,
    yParity: signedAuth.yParity ?? 0,
    r: signedAuth.r,
    s: signedAuth.s,
  };

  console.log(`  ✓ Authorization signed`);
  console.log(`  EOA ${userAddress} → delegates to ${delegateAddress}\n`);

  return { depositTx, authorization };
}

// ---------------------------------------------------------------------------
// Step 3: Submit via /execute (sponsor pays gas, user pays nothing)
// ---------------------------------------------------------------------------

async function executeGasless(
  quote: QuoteResponse,
  depositTx: QuoteResponse["steps"][0]["items"][0]["data"],
  authorization: SignedAuthorization
): Promise<string> {
  console.log("━━━ Step 3: Submit via /execute (gasless) ━━━\n");

  // ┌──────────────────────────────────────────────────────────────┐
  // │  This is the key difference from the regular /quote flow.    │
  // │                                                              │
  // │  Instead of the USER submitting the origin tx (and paying    │
  // │  gas), we POST the signed authorization to /execute and      │
  // │  the SPONSOR'S RELAYER submits it. The user never touches    │
  // │  gas. They only signed an off-chain 7702 authorization.      │
  // └──────────────────────────────────────────────────────────────┘

  const requestBody: ExecuteGaslessRequest = {
    executionKind: "rawCalls",
    data: {
      chainId: depositTx.chainId,
      to: depositTx.to,
      data: depositTx.data,
      value: depositTx.value || "0",
      authorizationList: [authorization],
    },
    executionOptions: {
      referrer: "relay-example-full-subsidy",
      subsidizeFees: true,
    },
    // Cross-chain: include requestId from the prior /quote call
    // so the solver knows this is a bridge, not a same-chain execution
    requestId: quote.requestId,
  };

  console.log("  Request body:");
  console.log(`    executionKind:  rawCalls`);
  console.log(`    chain:          ${depositTx.chainId}`);
  console.log(`    target:         ${depositTx.to}`);
  console.log(`    subsidizeFees:  true`);
  console.log(
    `    requestId:      ${quote.requestId || "(generated by solver)"}`
  );
  console.log(`    authList:       1 signed authorization\n`);

  if (DRY_RUN) {
    console.log("  [DRY RUN] Skipping /execute call. Request body is valid.\n");
    return quote.requestId || "dry-run-request-id";
  }

  if (!RELAY_API_KEY) {
    console.log("  [SKIP] No RELAY_API_KEY set. The /execute endpoint");
    console.log("  requires an x-api-key header with a key that has a");
    console.log("  funded sponsoringWalletAddress configured.\n");
    return quote.requestId || "no-api-key";
  }

  const res = await fetch(`${RELAY_API}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // /execute uses x-api-key header (not Bearer auth)
      "x-api-key": RELAY_API_KEY,
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Execute failed (${res.status}): ${error}`);
  }

  const result: ExecuteGaslessResponse = await res.json();

  console.log(`  ✓ ${result.message}`);
  console.log(`  Request ID: ${result.requestId}\n`);

  return result.requestId;
}

// ---------------------------------------------------------------------------
// Step 4: Poll until destination chain execution completes
// ---------------------------------------------------------------------------

async function pollStatus(requestId: string): Promise<void> {
  console.log("━━━ Step 4: Monitor relay execution ━━━\n");
  console.log(`  Request ID: ${requestId}`);

  if (DRY_RUN || !RELAY_API_KEY) {
    console.log("  [SKIP] Polling skipped (dry run or no API key).\n");
    return;
  }

  const maxAttempts = 60;
  const pollInterval = 5_000;

  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(
      `${RELAY_API}/intents/status/v3?requestId=${requestId}`
    );
    const status: StatusResponse = await res.json();

    console.log(`  [${i + 1}/${maxAttempts}] Status: ${status.status}`);

    if (status.status === "success") {
      console.log("\n  ✅ Bridge complete!");
      if (status.txHashes?.length) {
        console.log(`  Destination tx: ${status.txHashes[0]}`);
      }
      return;
    }

    if (status.status === "failure" || status.status === "refund") {
      throw new Error(`Relay failed with status: ${status.status}`);
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  throw new Error("Polling timed out — check status manually");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printFeeBreakdown(quote: QuoteResponse) {
  const { fees } = quote;

  console.log("  ┌────────────────────────────────────────────────┐");
  console.log("  │              FEE BREAKDOWN                     │");
  console.log("  ├────────────────────────────────────────────────┤");

  const rows = [
    ["Origin gas", fees.gas],
    ["Dest gas (relayerGas)", fees.relayerGas],
    ["Relayer service", fees.relayerService],
    ["App fee", fees.app],
  ] as const;

  for (const [label, fee] of rows) {
    if (fee) {
      const usd = fee.amountUsd
        ? `$${Number(fee.amountUsd).toFixed(4)}`
        : "$0.00";
      const formatted = fee.amountFormatted || "0";
      const symbol = fee.currency?.symbol || "";
      console.log(
        `  │  ${label.padEnd(22)} ${formatted.padStart(14)} ${symbol.padEnd(5)} (${usd})`
      );
    }
  }

  console.log("  ├────────────────────────────────────────────────┤");

  if (fees.subsidized) {
    const subUsd = fees.subsidized.amountUsd
      ? `$${Number(fees.subsidized.amountUsd).toFixed(4)}`
      : "$0.00";
    console.log(`  │  SUBSIDIZED (sponsor)  ${subUsd.padStart(22)} │`);
  }

  // In the /execute flow, origin gas is also covered by the sponsor.
  // The user pays literally nothing.
  console.log(`  │  USER PAYS                              $0.00 │`);
  console.log(`  │                                               │`);
  console.log(`  │  Origin gas is ALSO covered — the sponsor's   │`);
  console.log(`  │  relayer submits the tx via POST /execute.    │`);
  console.log("  └────────────────────────────────────────────────┘");

  if (quote.details?.currencyOut) {
    const out = quote.details.currencyOut;
    console.log(
      `\n  User receives: ${out.amountFormatted} ${out.currency?.symbol} on chain ${out.currency?.chainId}`
    );
    console.log("  (Zero deductions — sponsor covered everything)");
  }

  if (quote.details?.timeEstimate) {
    console.log(`  Estimated time: ~${quote.details.timeEstimate}s`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("╔════════════════════════════════════════════════════╗");
  console.log("║  Relay Protocol: Full Subsidy EOA (Gasless)       ║");
  console.log("║  BYO Wallet + EIP-7702 + /execute                 ║");
  console.log("║                                                    ║");
  console.log("║  User signs a 7702 authorization (no gas).         ║");
  console.log("║  Sponsor's relayer submits + pays for everything.  ║");
  console.log("╚════════════════════════════════════════════════════╝");

  const userAddress: Address = USER_PRIVATE_KEY
    ? privateKeyToAccount(USER_PRIVATE_KEY).address
    : "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"; // placeholder for dry run

  try {
    // 0. Check if EOA is already 7702-delegated to Relay's erc20Router
    const { isDelegated, delegateAddress } = await checkAndSetupDelegation(
      userAddress,
      ORIGIN_CHAIN_ID
    );

    // 1. Get a subsidized quote (requestId + deposit tx details)
    const quote = await getSubsidizedQuote(userAddress);

    // 2. User signs 7702 authorization (off-chain, gasless)
    //    → delegates EOA to Relay erc20Router (NOT the deposit target)
    //    → skipped if already delegated
    const signed = await signAuthorization(
      quote,
      delegateAddress,
      isDelegated,
      userAddress
    );
    if (!signed) {
      console.log("  No transaction to execute. Done.\n");
      return;
    }

    // 3. POST /execute — sponsor submits the tx, pays origin gas
    const requestId = await executeGasless(
      quote,
      signed.depositTx,
      signed.authorization
    );

    // 4. Poll until destination execution completes
    await pollStatus(requestId);

    console.log("\n━━━ Done ━━━\n");
  } catch (err) {
    console.error("\n❌ Error:", (err as Error).message);
    process.exit(1);
  }
}

main();
