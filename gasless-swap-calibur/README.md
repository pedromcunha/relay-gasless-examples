# Gasless Swap with Calibur + Relay /execute

**Use case:** App-controlled wallets that want 100% gasless swaps without permit dependencies or full ERC-4337 infrastructure.

## The Problem

Getting fully gasless ERC-20 swaps is hard:

- **Permit** only covers some tokens — not all ERC-20s implement it
- **ERC-4337** is powerful but overkill — you need a bundler, paymaster, smart account provider
- Users shouldn't need to hold gas tokens to swap

## The Solution

Use [Calibur](https://github.com/Uniswap/calibur) (Uniswap's minimal batch executor) as a lightweight smart wallet via EIP-7702 delegation. This gives the EOA the ability to batch calls — specifically, `approve` + `deposit` — in a single atomic transaction submitted by the sponsor via Relay's `/execute` API.

No bundler. No paymaster. No permit. Works with any ERC-20.

### Who pays what

| Fee component    | Paid by | How                                                                                   |
| ---------------- | ------- | ------------------------------------------------------------------------------------- |
| Origin chain gas | Sponsor | Relayer submits the tx via `POST /execute`, `subsidizeFees: true` in executionOptions |
| Relay fees       | Sponsor | `subsidizeFees: true` in quote parameters                                             |

### When to use this

- Your app **controls the user's wallet** (embedded wallets, custodial, etc.)
- You want gasless swaps that work with **any ERC-20 token**
- You don't want to set up ERC-4337 infrastructure (bundlers, paymasters)
- You're willing to sponsor gas for your users (temporarily then recouped via app fees or fully)

If the user brings their own external wallet (MetaMask, Rainbow), they can't delegate via 7702 without the wallet's cooperation — consider permit-based flows instead.

## How it works

```
App (controls user's private key)
    │
    │  0. Check if EOA is 7702-delegated to Calibur
    │     → getCode(eoa) — look for 0xef0100 + calibur address
    │
    │  1. POST /quote → get deposit tx details
    │     → Same-chain swap: USDC → ETH on Base
    │
    │  2. Build batched call via Calibur's execute(BatchedCall):
    │     → Call 1: approve(relay_deposit_contract, amount)
    │     → Call 2: deposit(...)  — the tx from /quote
    │     → These execute atomically as the user's EOA
    │
    │  3. Sign EIP-7702 authorization (if not already delegated)
    │     → Delegates EOA → Calibur (0x000000009B1D0aF20D8C6d0A44e162d11F9b8f00)
    │     → Off-chain signature, no gas
    │
    │  4. POST /execute → sponsor submits the batched tx
    │     → Target is the USER'S EOA (which runs Calibur's code via 7702)
    │     → subsidizeFees: true → sponsor pays origin tx fees
    │
    ▼
User receives output tokens, paid nothing
```

### Why target the user's EOA in /execute?

Because the EOA is delegated to Calibur via 7702, calling `execute(batchedCall)` on the EOA runs Calibur's batch execution code in the EOA's context. The EOA is both the caller and the execution context — it approves tokens and deposits them atomically.

## Calibur

[Calibur](https://github.com/Uniswap/calibur) is Uniswap's minimal, non-upgradeable smart wallet contract designed for EIP-7702 delegation.

- **Address:** `0x000000009B1D0aF20D8C6d0A44e162d11F9b8f00` (same on all chains)
- **Deployed on:** Mainnet, Base, Arbitrum, Optimism, Unichain, BNB
- **Audited by:** OpenZeppelin, Cantina

The only feature we use here is `execute(BatchedCall)` — batch multiple calls atomically:

```solidity
struct Call {
    address to;
    uint256 value;
    bytes data;
}

struct BatchedCall {
    Call[] calls;
    bool revertOnFailure;
}

function execute(BatchedCall memory batchedCall) external payable;
```

Calibur also supports key management, ERC-4337, and signed batch execution — but for this flow, direct batch execution is all you need.

## Running the example

```bash
npm install

# Dry run — shows the full flow without making API calls
npm run demo:dry-run

# With API key (gets a real quote, shows fee breakdown)
RELAY_API_KEY=your-key npm run demo:dry-run

# Full execution (requires funded sponsor wallet + test EOA with USDC)
RELAY_API_KEY=your-key USER_PRIVATE_KEY=0x... npm run demo
```

### Environment variables

| Variable           | Required      | Description                                          |
| ------------------ | ------------- | ---------------------------------------------------- |
| `RELAY_API_KEY`    | Yes           | API key with `sponsoringWalletAddress` configured    |
| `USER_PRIVATE_KEY` | For execution | User's EOA private key (test wallets only!)          |
| `REFERRER`         | Yes           | Referrer that matches the API key                    |
| `CALIBUR_ADDRESS`  | No            | Override Calibur address (default: `0x0000...f00`)   |
| `DRY_RUN`          | No            | Set to `true` to skip execution                      |
| `RELAY_API_URL`    | No            | Override API URL (default: `https://api.relay.link`) |

## Comparison with other approaches

| Approach                              | Token coverage                | Infrastructure needed                      | Complexity |
| ------------------------------------- | ----------------------------- | ------------------------------------------ | ---------- |
| **Calibur + /execute** (this example) | Any ERC-20                    | None (just Relay API key, fee sponsorship) | Low        |
| Permit + /quote                       | Only permit-compatible tokens | None                                       | Low        |
| ERC-4337 + paymaster                  | Any ERC-20                    | Bundler, paymaster, smart account          | High       |
| ERC-4337 + Relay /execute             | Any ERC-20                    | Smart account provider                     | Medium     |

## Related examples

- **full-subsidy-eoa** — Same gasless pattern but delegating to Relay's erc20Router for cross-chain bridging
