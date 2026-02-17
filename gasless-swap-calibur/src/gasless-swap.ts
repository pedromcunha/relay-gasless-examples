/**
 * Gasless Swap with Calibur BatchExecutor + Relay /execute
 *
 * Delegates an EOA to Calibur (Uniswap's minimal batch executor) via EIP-7702,
 * batches approve + deposit atomically, and submits via Relay /execute with
 * full fee sponsorship. Works with any ERC-20 — no permit required.
 *
 * Flow:
 *   1. Get a swap quote from Relay
 *   2. Sign EIP-7702 authorization (delegate EOA → Calibur) if needed
 *   3. Sign the batch via EIP-712 (Calibur's signed execution path)
 *   4. Submit via Relay /execute
 *   5. Poll for completion
 */

import "dotenv/config";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseUnits,
  encodeFunctionData,
  encodeAbiParameters,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, optimism } from "viem/chains";
import {
  CALIBUR_ADDRESS,
  CALIBUR_ABI,
  CALIBUR_EIP712_TYPES,
  CALIBUR_SALT,
  ROOT_KEY_HASH,
} from "./calibur.js";
import { relayFetch, pollStatus } from "./relay.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RELAY_API_KEY = process.env.RELAY_API_KEY!;
const USER_PRIVATE_KEY = process.env.USER_PRIVATE_KEY! as Hex;
const REFERRER = process.env.REFERRER! as string;

if (!RELAY_API_KEY) throw new Error("RELAY_API_KEY is required");
if (!USER_PRIVATE_KEY) throw new Error("USER_PRIVATE_KEY is required");

// Cross-chain swap: Based Pengu on Base → USDC on Optimism
const ORIGIN_CHAIN_ID = base.id;
const DESTINATION_CHAIN_ID = optimism.id;
const INPUT_TOKEN = "0x01e6bd233f7021e4f5698a3ae44242b76a246c0a" as Address;
const OUTPUT_TOKEN = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as Address;
const SWAP_AMOUNT = "100000";
const INPUT_DECIMALS = 18;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const account = privateKeyToAccount(USER_PRIVATE_KEY);
  const userAddress = account.address;

  const publicClient = createPublicClient({ chain: base, transport: http() });
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(),
  });

  console.log(`User: ${userAddress}`);
  console.log(`Swap: ${SWAP_AMOUNT} PENGU (Base) → USDC (Optimism)\n`);

  // ── 1. Check delegation ──────────────────────────────────────────────

  const code = await publicClient.getCode({ address: userAddress });
  const isDelegated =
    code?.toLowerCase().startsWith("0xef0100") &&
    code.slice(8).toLowerCase() === CALIBUR_ADDRESS.slice(2).toLowerCase();

  console.log(
    `Delegation: ${isDelegated ? "already delegated" : "needs delegation"}`
  );

  // ── 2. Get quote ─────────────────────────────────────────────────────

  const quote = await relayFetch("/quote", {
    user: userAddress,
    originChainId: ORIGIN_CHAIN_ID,
    destinationChainId: DESTINATION_CHAIN_ID,
    originCurrency: INPUT_TOKEN,
    destinationCurrency: OUTPUT_TOKEN,
    amount: parseUnits(SWAP_AMOUNT, INPUT_DECIMALS).toString(),
    tradeType: "EXACT_INPUT",
    recipient: userAddress,
    //Enable this to completely sponsor destination execution
    subsidizeFees: false,
    //Enable this to recoup the origin gas fee
    appFees: [
      {
        recipient: "0x03508bB71268BBA25ECaCC8F620e01866650532c",
        fee: "80",
      },
    ],
  });

  const outInfo = quote.details?.currencyOut;
  if (outInfo) {
    console.log(
      `Quote: receive ${outInfo.amountFormatted} ${outInfo.currency?.symbol} on chain ${outInfo.currency?.chainId}`
    );
  }

  // ── 3. Extract calls from quote steps ────────────────────────────────

  // The quote returns approve + deposit as separate tx items.
  // We batch them into a single atomic Calibur execute call.
  // The requestId lives on each step object (same value) — hoist it.
  const calls: Array<{ to: Address; value: bigint; data: Hex }> = [];
  let requestId: string | undefined;
  for (const step of quote.steps) {
    if (step.kind !== "transaction") continue;
    for (const item of step.items) {
      calls.push({
        to: item.data.to,
        value: BigInt(item.data.value || "0"),
        data: item.data.data,
      });
    }
    if (step.requestId) requestId = step.requestId;
  }
  if (calls.length === 0) throw new Error("No transaction steps in quote");
  console.log(`Batch: ${calls.length} calls`);
  for (let i = 0; i < calls.length; i++) {
    console.log(
      `  Call ${i + 1}: to=${calls[i].to} value=${calls[i].value} data=${calls[i].data.slice(0, 10)}...`
    );
  }

  // ── 4. Sign EIP-7702 authorization (if needed) ──────────────────────

  let authorization = null;
  if (!isDelegated) {
    const currentNonce = await publicClient.getTransactionCount({
      address: userAddress,
    });
    const signedAuth = await walletClient.signAuthorization({
      contractAddress: CALIBUR_ADDRESS,
      chainId: ORIGIN_CHAIN_ID,
      nonce: currentNonce,
    });
    authorization = {
      chainId: Number(signedAuth.chainId),
      address: signedAuth.address,
      nonce: signedAuth.nonce,
      yParity: signedAuth.yParity ?? 0,
      r: signedAuth.r,
      s: signedAuth.s,
    };
    console.log("Signed 7702 authorization");
  }

  // ── 5. Sign batch via EIP-712 (Calibur signed execution) ────────────

  // Why signed execution: the direct execute(BatchedCall) checks msg.sender
  // is the owner. Since Relay's relayer submits the tx, msg.sender would be
  // the relayer — not the EOA. The signed path verifies an EIP-712 signature
  // instead, and executor=address(0) means any address can submit.

  // Read Calibur nonce (starts at 0 if not yet delegated)
  let caliburNonce = 0n;
  try {
    const seq = await publicClient.readContract({
      address: userAddress,
      abi: CALIBUR_ABI,
      functionName: "getSeq",
      args: [0n],
    });
    caliburNonce = BigInt(seq);
    console.log(`Calibur nonce: ${caliburNonce}`);
  } catch (e) {
    console.log(
      `Calibur nonce: 0 (getSeq failed: ${(e as Error).message?.slice(0, 80)})`
    );
  }

  const signedBatchedCall = {
    batchedCall: {
      calls: calls.map((c) => ({ to: c.to, value: c.value, data: c.data })),
      revertOnFailure: true,
    },
    nonce: caliburNonce,
    keyHash: ROOT_KEY_HASH,
    executor: "0x0000000000000000000000000000000000000000" as Address,
    deadline: 0n,
  };

  const signature = await walletClient.signTypedData({
    domain: {
      name: "Calibur",
      version: "1.0.0",
      chainId: BigInt(ORIGIN_CHAIN_ID),
      verifyingContract: userAddress,
      salt: CALIBUR_SALT,
    },
    types: CALIBUR_EIP712_TYPES,
    primaryType: "SignedBatchedCall",
    message: signedBatchedCall,
  });

  // wrappedSignature = abi.encode(signature, hookData) — empty hookData for root key
  const wrappedSignature = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes" }],
    [signature, "0x"]
  );

  const batchCallData = encodeFunctionData({
    abi: CALIBUR_ABI,
    functionName: "execute",
    args: [signedBatchedCall, wrappedSignature],
  });

  console.log("Signed EIP-712 batch");
  console.log(`Request ID: ${requestId ?? "(none)"}`);


  // ── 6. Submit via /execute ───────────────────────────────────────────

  const executeResult = await relayFetch("/execute", {
    executionKind: "rawCalls",
    data: {
      chainId: ORIGIN_CHAIN_ID,
      to: userAddress,
      data: batchCallData,
      value: "0",
      ...(authorization ? { authorizationList: [authorization] } : {}),
    },
    executionOptions: {
      referrer: REFERRER,
      //Enable this to completely cover origin fees
      subsidizeFees: false,
    },
    ...(requestId ? { requestId } : {}),
  });

  console.log(`Submitted: ${executeResult.requestId}`);

  // ── 7. Poll ──────────────────────────────────────────────────────────

  await pollStatus(executeResult.requestId);
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("\nError:", err.message);
  process.exit(1);
});
