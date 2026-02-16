# Full Subsidy EOA Example — True Gasless

**Decision tree path:** BYO Wallet → EIP-7702 → Full Fee Subsidization

## Use Case

The app subsidizes **all** fees — including origin chain gas. The user connects their existing wallet, signs an off-chain EIP-7702 authorization, and the sponsor's relayer submits and pays for the transaction. The user never needs to hold native tokens.

### Who pays what

| Fee component         | Paid by      | How                                        |
| --------------------- | ------------ | ------------------------------------------ |
| Origin chain gas      | Sponsor      | Relayer submits the tx via `POST /execute` |
| Destination chain gas | Sponsor      | `subsidizeFees: true` in execution options |
| Relayer service fee   | Sponsor      | `subsidizeFees: true` in execution options |
| App fees              | App (waived) | Not charged or absorbed by app             |

### Why this approach

- **True gasless** — user never touches gas, never needs ETH on origin chain
- **BYO wallet** — user keeps their existing EOA address, no migration
- **EIP-7702** — user signs an off-chain authorization that lets the sponsor submit a tx on their behalf, without changing their address or moving funds

### Trade-offs

- Highest cost to the app per transaction
- Requires a funded sponsor wallet linked to your API key
- Need rate limiting / spend controls to prevent abuse

## How it works

```
User's EOA (e.g. MetaMask)
    │
    │  0. App checks EIP-7702 delegation status
    │     → getCode(eoa) — is it already delegated to Relay's erc20Router?
    │     → If not: user will sign a 7702 authorization in step 2
    │     → If yes: skip authorization, delegation persists across txs
    │     → THIS IS THE APP'S RESPONSIBILITY — Relay does not handle it
    │
    │  1. App calls POST /quote with subsidizeFees: true
    │     → Gets requestId + deposit tx details + fee breakdown
    │
    │  2. User signs EIP-7702 authorization (OFF-CHAIN, no gas)
    │     → EOA delegates to the Relay erc20Router (NOT the deposit target)
    │     → The router has delegatecallMulticall for executing in EOA context
    │     → This is just a signature — user pays nothing
    │     → Skipped if already delegated from a previous tx
    │
    │  3. App calls POST /execute with signed authorization
    │     → SPONSOR'S RELAYER submits the origin tx (pays gas)
    │     → subsidizeFees: true covers relay/destination fees
    │     → User's wallet is never charged
    │
    │  4. Relay solver executes on destination chain
    │     → All destination fees covered by sponsor
    │
    ▼
User receives full output amount on destination chain
(zero deductions, zero gas spent)
```

## Key difference: /quote vs /execute

The regular `/quote` flow assumes the **user** submits the origin chain transaction (and pays gas for it). Even with `subsidizeFees: true`, origin gas is still on the user.

The `/execute` flow flips this: the **sponsor's relayer** submits the origin tx. The user only signs a 7702 authorization (off-chain, gasless). Combined with `subsidizeFees: true`, this means the user pays absolutely nothing.

```
Regular flow:   /quote → user submits tx (pays origin gas) → relay covers dest
Gasless flow:   /quote → user signs 7702 → /execute (sponsor submits everything)
```

## EIP-7702 delegation setup (Step 0)

**This is the app developer's responsibility.** Relay does not handle delegation — your app must check if the user's EOA is already delegated and request authorization if not.

The delegation target is the **Relay erc20Router** contract, not the deposit target. The router has a `delegatecallMulticall` function that lets the solver execute deposit logic in the context of the user's EOA.

```typescript
// Relay erc20Router v2 — same address across all major EVM chains
const RELAY_ERC20_ROUTER = "0xf5042e6ffac5a625d4e7848e0b01373d8eb9e222";

// Check delegation status via getCode()
const code = await publicClient.getCode({ address: eoaAddress });

if (!code || code === "0x") {
  // Plain EOA — needs 7702 authorization (signed in Step 2)
} else if (code.toLowerCase().startsWith("0xef0100")) {
  // Already 7702-delegated — check if it's to the Relay router
  const delegate = "0x" + code.slice("0xef0100".length);
  if (delegate.toLowerCase() === RELAY_ERC20_ROUTER.toLowerCase()) {
    // ✓ Already delegated to Relay — skip authorization in Step 2
  } else {
    // Delegated to a different contract — needs re-authorization
  }
} else {
  // Has contract code but not 7702 — this is a smart wallet, not an EOA.
  // Use the EIP-4337 flow instead.
}
```

The delegation persists across transactions. Once a user's EOA is delegated to the Relay router, subsequent transactions can skip the authorization step entirely — just include an empty authorization list in the `/execute` call.

## API details

### POST /execute

```typescript
// Header: x-api-key (NOT Bearer auth)
const res = await fetch("https://api.relay.link/execute", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": API_KEY, // Must have sponsoringWalletAddress configured
  },
  body: JSON.stringify({
    executionKind: "rawCalls",
    data: {
      chainId: 42161, // Origin chain
      to: depositTx.to, // Deposit contract from /quote
      data: depositTx.data, // Encoded deposit call from /quote
      value: depositTx.value, // ETH value from /quote
      authorizationList: [
        {
          // User's signed 7702 authorization
          chainId: 42161,
          address: "0xf504...e222", // Relay erc20Router (NOT depositTx.to)
          nonce: 0,
          yParity: 0,
          r: "0x...",
          s: "0x...",
        },
      ],
    },
    executionOptions: {
      referrer: "your-app-name",
      subsidizeFees: true, // Sponsor pays all fees
    },
    requestId: "0x...", // From /quote response (cross-chain)
  }),
});

// Response: { message: "Transaction submitted", requestId: "0x..." }
```

### EIP-7702 authorization

The user signs this off-chain — no gas, no on-chain transaction. The delegate target is the **Relay erc20Router**, not the deposit contract:

```typescript
// Using viem
const RELAY_ERC20_ROUTER = "0xf5042e6ffac5a625d4e7848e0b01373d8eb9e222";

const authorization = await walletClient.signAuthorization({
  contractAddress: RELAY_ERC20_ROUTER, // Relay erc20Router, NOT depositTx.to
  chainId: originChainId,
  nonce: currentEOANonce,
});
```

This delegates the user's EOA to the Relay erc20Router, which has a `delegatecallMulticall` function. The solver uses this to execute the deposit logic in the context of the user's EOA — the EOA temporarily "becomes" the router and can approve + transfer tokens. The delegation persists until overwritten by another 7702 authorization.

## Running the example

```bash
npm install

# Dry run — gets a real quote, shows the full flow, skips execution
npm run demo:dry-run

# With API key (shows subsidized fee breakdown)
RELAY_API_KEY=your-key npm run demo:dry-run

# Full execution (requires funded sponsor wallet + test EOA)
RELAY_API_KEY=your-key USER_PRIVATE_KEY=0x... npm run demo
```

### Environment variables

| Variable           | Required      | Description                                          |
| ------------------ | ------------- | ---------------------------------------------------- |
| `RELAY_API_KEY`    | Yes           | API key with `sponsoringWalletAddress` configured    |
| `USER_PRIVATE_KEY` | For execution | User's EOA private key (test wallets only!)          |
| `DRY_RUN`          | No            | Set to `true` to skip tx submission                  |
| `RELAY_API_URL`    | No            | Override API URL (default: `https://api.relay.link`) |

## Related examples

- **Hybrid subsidy** → `/quote` flow where app pays origin gas only, user pays destination fees from output tokens
- **ETH-less** → `/execute` flow where sponsor fronts gas temporarily but recoups from user's destination output
- **Embedded + 4337** → Same fee models but with app-created smart contract wallets + UserOperations
