# BYO EOA Permit Bridge

**Decision tree path:** BYO Wallet → Permit-compatible ERC-20 → Signature-only (no approval tx)

## Use Case

The user connects their existing EOA wallet (MetaMask, Rainbow, etc.) and bridges permit-compatible ERC-20 tokens cross-chain with a single off-chain signature. No approval transaction required — the EIP-2612 / EIP-3009 permit signature replaces it. Relay's solver handles execution on both chains.

### Who pays what

| Fee component         | Paid by                    | How                                                         |
| --------------------- | -------------------------- | ----------------------------------------------------------- |
| Origin chain approval | Eliminated                 | Permit signature replaces on-chain `approve` tx             |
| Origin chain gas      | Relay solver               | Solver submits the deposit tx using the signed permit       |
| Relay service fee     | User (deducted from output)| Taken from output amount at time of quote                   |
| Destination chain gas | Relay solver               | Covered by the relay fee included in the quote              |

### Why this approach

- **No approval tx** — permit replaces the separate on-chain `approve`, saving gas and a wallet prompt
- **BYO wallet** — user keeps their existing EOA; no new account creation or migration
- **Token-limited** — only works with permit-compatible tokens (USDC, USDT). For arbitrary ERC-20s, see the Calibur or ERC-4337 examples

### Trade-offs

- Requires the token to implement EIP-2612 or EIP-3009 permit
- User pays relay fees out of output amount (not fully subsidized)
- Some wallets may not display EIP-712 permit messages clearly

## How it works

```
User's EOA (e.g. MetaMask)
    │
    │  1. App calls POST /quote/v2 with usePermit: true
    │     → Gets permit signature request + fee breakdown
    │     → No subsidizeFees: relay costs deducted from output
    │
    │  2. User signs EIP-712 typed-data permit (OFF-CHAIN, no gas)
    │     → Grants Relay's solver permission to pull tokens
    │     → This is just a wallet signature — no transaction sent
    │
    │  3. App posts permit signature to Relay's endpoint
    │     → Relay's solver submits the deposit tx on origin chain
    │     → Uses the permit to pull tokens from the user's EOA
    │
    │  4. Relay solver fulfills on destination chain
    │     → User receives output tokens (minus relay fee)
    │
    ▼
User receives output tokens — signed once, paid no gas
```

## Key API detail: `usePermit: true`

Passing `usePermit: true` to `/quote/v2` tells Relay to return a permit-based signature step instead of a raw transaction approval. The quote response includes:

- A `signature` step with EIP-712 typed data for the permit
- A `post` target for submitting the signed permit to Relay

The hook processes steps in order: signs the permit, posts it, then polls for fill completion.

```typescript
const quote = await fetch("https://api.relay.link/quote/v2", {
  method: "POST",
  body: JSON.stringify({
    user: "0x...",               // User's EOA address
    originChainId: 8453,         // e.g. Base
    destinationChainId: 42161,   // e.g. Arbitrum
    originCurrency: "0x833...",  // USDC on Base
    destinationCurrency: "0x...",
    amount: "1000000",           // 1 USDC (6 decimals)
    tradeType: "EXACT_INPUT",
    usePermit: true,             // ← enables permit flow
  }),
});
```

## Architecture

```
byo-eoa-permit/
  app/
    page.tsx               # Entry point — title + BridgeForm
    providers.tsx          # wagmi + RainbowKit + React Query setup
  components/
    BridgeForm.tsx         # Main form — chain/token selection, quote, execute
    ChainSelector.tsx      # Chain picker dropdown
    CurrencySelector.tsx   # Token picker dropdown
    QuoteDisplay.tsx       # Fee breakdown display
    ExecuteButton.tsx      # Submit button with loading state
    ProgressTracker.tsx    # Step-by-step progress UI
  hooks/
    useRelayQuote.ts       # Fetches + auto-refreshes quote (React Query)
    useRelayExecute.ts     # Execution state machine (sign → post → poll)
    useRelayChains.ts      # Supported chain list
    useRelayCurrencies.ts  # Origin (permit-only) + destination token lists
  lib/
    relay.ts               # API helpers: getQuote, postSignature, pollStatus
    types.ts               # TypeScript types for Relay API responses
    wagmi.ts               # wagmi chain + connector config
    constants.ts           # Chain list, permit-compatible token addresses
```

## Supported tokens

Origin tokens are filtered to permit-compatible tokens only:

| Chain     | Tokens         |
| --------- | -------------- |
| Ethereum  | USDC, USDT     |
| Optimism  | USDC, USDT     |
| Polygon   | USDC, USDT     |
| Base      | USDC           |
| Arbitrum  | USDC, USDT     |

Destination tokens include native gas tokens (ETH, POL) in addition to the permit tokens above.

## Running the example

```bash
npm install

# Copy the env template
cp .env.local.example .env.local
```

Fill in `.env.local`:

```
NEXT_PUBLIC_RELAY_API_KEY=your_key_here
```

```bash
# Start the dev server (runs on port 3002)
npm run dev
```

Open [http://localhost:3002](http://localhost:3002), connect a wallet, and bridge.

### Environment variables

| Variable                    | Required | Description                                          |
| --------------------------- | -------- | ---------------------------------------------------- |
| `NEXT_PUBLIC_RELAY_API_KEY` | No       | Relay API key — omit for unauthenticated rate limits |

## Related examples

- **full-subsidy-eoa** — EIP-7702 flow where sponsor pays origin gas too (fully gasless for the user)
- **gasless-swap-calibur** — EIP-7702 + Calibur batch execution for any ERC-20 (no permit needed)
- **4337-gasless** — ERC-4337 smart account with Relay `/execute` for app-controlled wallets
