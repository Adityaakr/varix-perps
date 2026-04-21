# Varix---Perps-on-Vara

<img width="1498" height="824" alt="Screenshot 2026-04-21 at 9 04 29 PM" src="https://github.com/user-attachments/assets/e1b365e7-a81a-407f-9661-e674bf021295" />

# Varix Perps

Varix Perps is a Vara-native perpetual futures stack built around isolated Sails programs, typed off-chain services, and a Hyperliquid-inspired React terminal.

Important: the current runnable UI now supports **two runtimes**:

- `demo` mode uses the local trading engine for a full local end-to-end flow.
- `vara` mode uses a real Vara wallet plus runtime-parsed Sails IDLs for signed `Deposit`, `Withdraw`, `OpenPosition`, and `ClosePosition` calls when deployed program IDs are configured.

Without deployed program IDs, the app falls back visibly to demo mode.

The current repository ships:

- Phase 1 Vara contracts for collateral, oracle ingress, isolated market state, funding, and liquidation logic.
- A live local trading engine in the indexer with sessions, collateral, order entry, funding settlement, and liquidation checks for demo mode.
- Real price feeds from Pyth Hermes and Hyperliquid into the local engine.
- A React/Vite trading terminal with market selection, chart panel, order book, collateral actions, position management, and wallet-aware Vara mode.
- Local development orchestration with `pnpm` and Docker Compose.

## Repository Layout

```text
contracts/
  shared/
  session-registry/
  margin-vault/
  oracle-service/
  perp-market/
  market-factory/
  funding-scheduler/
  liquidation-manager/
services/
  oracle-relay/
  liquidation-watcher/
  indexer/
  market-data-proxy/
web/
docs/
```

## Contract Status

The Vara side is the most complete part of the repo today.

- `margin-vault` implements deposit, withdraw, lock, release, and slash accounting with market authorization.
- `oracle-service` verifies signed relayer payloads and stores the latest asset quotes.
- `perp-market` implements isolated positions, funding accrual, margin adjustments, and liquidation checks.
- `session-registry` implements one active session per trader with expiry-aware permission validation for later signless flows.
- `market-factory`, `funding-scheduler`, and `liquidation-manager` are control-plane scaffolds that still need deeper cross-program wiring.

### Verified Rust Tests

These contract suites pass locally:

```bash
cargo test --manifest-path contracts/margin-vault/Cargo.toml
cargo test --manifest-path contracts/oracle-service/Cargo.toml
cargo test --manifest-path contracts/perp-market/Cargo.toml
cargo test --manifest-path contracts/session-registry/Cargo.toml
```

Known environment gap:

- `cargo-sails` was not installable in this workspace because native `pkg-config` / OpenSSL prerequisites are missing, so the Sails workspace shape was recreated manually from the official template layout.

## TypeScript Workspace

The Node workspace uses `pnpm`.

### Install

```bash
pnpm install
```

### Common Commands

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm start
pnpm dev:web
pnpm dev:indexer
pnpm dev:oracle
pnpm dev:liq
pnpm dev:data
```

For a single-host local runtime that mirrors deployment mode:

```bash
cp .env.example .env
pnpm build
pnpm start
```

## Service Overview

### `services/oracle-relay`

- Polls Pyth Hermes for BTC, ETH, and SOL quotes.
- Signs relay payloads with an Ed25519 private key.
- Prepares payloads for `oracle-service`.

### `services/indexer`

- Acts as the local trading engine and event store.
- Maintains sessions, balances, positions, funding, and insurance state.
- Exposes REST endpoints for trading actions and WebSocket snapshots for the terminal.

### `services/market-data-proxy`

- Fetches Hyperliquid candle snapshots using `POST /info`.
- Pulls live mark prices and L2 book snapshots from Hyperliquid.
- Publishes mark prices into the indexer and fans out book/candle snapshots to the frontend.

### `services/liquidation-watcher`

- Polls the engine for stressed positions.
- Calls the liquidation endpoint as a safety net if equity collapses near the liquidation threshold.

## Frontend

The web app lives in `web/` and uses React + Vite.

Key UI modules:

- `MarketSelector`
- `Chart`
- `OrderBook`
- `OrderForm`
- `PositionsTable`
- `NavBar`

The current UI supports:

- `demo` runtime with local session creation, local collateral, local order entry, and local position close
- demo `tUSDC` faucet, wallet balance, LP seeding, and LP-backed trade capacity for end-to-end local testing
- `vara` runtime with `ApiProvider`, `AccountProvider`, `AlertProvider`, wallet readiness states, and signed contract actions through Sails runtime IDL parsing
- live Pyth/Hyperliquid-driven mark and index prices
- Hyperliquid-driven candles and order book depth

What still is **not** complete for the full `vara-skills` production path:

- signless session registration
- voucher sponsor backend for gasless trading
- deployed program IDs checked into a real testnet or mainnet environment
- indexer replacement of the remaining demo-only authority paths

## Docker Compose

`docker-compose.yml` starts:

- PostgreSQL
- indexer
- oracle relay
- liquidation watcher
- market data proxy
- web terminal

This stack currently assumes a reachable Vara RPC endpoint through environment variables. It does not yet boot a pinned local Vara node image inside Compose, and the signless or voucher-backed path from `vara-skills` is not implemented yet.

## Deployment Notes

- `Dockerfile` builds the full workspace and starts the runtime services in production mode.
- `.env.example` documents the runtime configuration surface.
- The repository is deployment-ready for a single-host or container platform, but it is not publishable from this machine yet because no hosting CLI, deploy token, or public infrastructure target is configured.

### Vara Runtime Env

To enable real wallet-signed Vara mode in the browser, set:

```bash
VITE_NODE_ADDRESS=wss://testnet.vara.network
VITE_SESSION_DURATION_BLOCKS=1800
VITE_SESSION_REGISTRY_PROGRAM_ID=0x...
VITE_MARGIN_VAULT_PROGRAM_ID=0x...
VITE_ORACLE_SERVICE_PROGRAM_ID=0x...
VITE_BTC_MARKET_PROGRAM_ID=0x...
VITE_ETH_MARKET_PROGRAM_ID=0x...
VITE_SOL_MARKET_PROGRAM_ID=0x...
```

The frontend still uses the market-data proxy for candles and order book depth, even in Vara mode. That is intentional and matches the Hyperliquid-style terminal split between execution and market-data UX.

Demo-mode trading now supports a full local collateral loop:
- mint demo `tUSDC` into the trader wallet balance
- fund the shared LP with `tUSDC`
- deposit `tUSDC` from wallet balance into margin collateral
- trade against live Pyth / Hyperliquid-fed prices with LP-backed notional limits

The next Vara-mode UX step is:
- first signed action: register a bounded session key in `session-registry`
- later actions: move from wallet-per-click toward session-backed calls signed by the delegated session key

Current frontend behavior in Vara mode:
- connect wallet
- sign `RegisterSession` against `session-registry`
- generate and persist a browser-local sr25519 session signer for the connected wallet
- optionally pre-fund that session signer with `VITE_SESSION_FUNDING_AMOUNT` VARA so it can pay gas without the main wallet on each action
- read the active session back from chain
- the contracts accept session identities for `Deposit`, `Withdraw`, `OpenPosition`, `AddMargin`, and `ClosePosition`
- when the local session signer matches the registered on-chain session, the browser signs those actions with the session key instead of the wallet
- voucher-backed sponsorship is still not wired, so the session account needs native VARA balance unless sponsorship is added

## Demo Walkthrough

See [docs/demo-script.md](/Users/adityakrx/Desktop/Varix/docs/demo-script.md) for a Loom-ready script aligned with the acceptance criteria.

## Remaining Work

- implement signless session registration and voucher-backed gas sponsorship
- finish factory-driven market deployment and testnet deployment scripts
- replace the owner recovery path used in gtests with explicit autonomous delayed-message assertions
- add bridge flows and conditional order support

See [docs/plans/2026-04-20-varix-perps-implementation-correction.md](/Users/adityakrx/Desktop/Varix/docs/plans/2026-04-20-varix-perps-implementation-correction.md) for the explicit architecture correction.
