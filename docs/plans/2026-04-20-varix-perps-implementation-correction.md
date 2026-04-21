# Varix Perps Implementation Correction

## Why This Exists

The current local runtime works as a demo, but it does **not** follow the standard Vara Sails frontend path from `vara-skills`.

The most important mismatch:

- the frontend does **not** use a real Vara wallet transaction flow
- the frontend does **not** use generated Sails clients against deployed programs
- the local `indexer` is acting as a synthetic trading engine, not as an indexer
- the "session" button is a local HTTP session token, not a real signless session key on Vara

That is why there is no real wallet-backed UX in the current app.

## What The Current App Actually Does

### Frontend

- `web/src/App.tsx` calls `useVaraProgram`
- `web/src/hooks/useVaraProgram.ts` sends ordinary HTTP requests to the local engine
- the "Start Session" button creates a local session token from `POST /api/session`
- deposit, withdraw, open, and close all call local REST endpoints

### Services

- `services/indexer/src/index.ts` currently owns balances, positions, funding, and liquidation state
- `services/oracle-relay/src/index.ts` pushes Pyth prices into that local engine
- `services/market-data-proxy/src/index.ts` pushes Hyperliquid marks into that local engine
- `services/liquidation-watcher/src/index.ts` calls the local liquidation endpoint

### Result

The current runtime is a **local perp simulator with live market data**, not a real Vara trading terminal.

## What The Vara Skills Require Instead

Per `vara-skills`, `ship-sails-app`, `sails-frontend`, and `voucher-and-signless-flows`:

### Frontend must use

- `@gear-js/react-hooks` provider stack
- wallet detection and account readiness states
- generated Sails client code from `.idl`
- real signed transactions for session creation
- voucher-backed or signless follow-up transactions only after session registration

### Backend/services must do

- index chain state and events
- relay oracle prices
- sponsor vouchers if the product requires gasless UX
- optionally maintain a signless session backend

### On-chain programs must own

- balances / collateral
- positions
- funding
- liquidation eligibility
- session authorization rules if signless is used

## Correct Target Architecture

### Source of truth

Move the source of truth fully on-chain:

- `margin-vault` owns collateral
- `perp-market` owns positions and funding
- `oracle-service` owns trusted quotes
- the frontend reads/query calls from deployed programs
- the indexer mirrors state for UX, analytics, and historical screens only

### Wallet + signless flow

1. User connects a real Vara wallet in the browser
2. User signs one transaction to create or register a session key
3. Sponsor service issues a voucher to that session key if gasless UX is enabled
4. Frontend sends follow-up program calls with generated Sails clients
5. Program logic enforces session expiry, allowed actions, and replay protection

### Frontend boundary

The frontend should do:

- wallet connection
- session registration transaction
- query calls through generated Sails client methods
- command sends through generated Sails transaction builders
- clear wallet readiness / disabled / pending / error states

The frontend should **not** own a fake local account ledger.

### Service boundary

The indexer should do:

- subscribe to chain events
- decode market/vault/oracle events
- serve history, leaderboard, and denormalized reads
- provide websocket fanout for UI freshness

The indexer should **not** accept `open`, `close`, `deposit`, or `withdraw` as authoritative trading actions once the real Vara path is in place.

## Required Refactor

### Frontend

- replace `useVaraProgram` local HTTP commands with Sails generated client calls
- add provider composition required by `sails-frontend`
- add real wallet states:
  - wallets loading
  - no wallet extension
  - wallet present but no account connected
  - account connected and ready
- rename or remove the current "Start Session" local-token UX

### Services

- split the current `indexer` into:
  - real indexer
  - optional sponsor/session service
- keep oracle relay and market-data proxy
- stop treating the indexer as the settlement engine

### Contracts

- complete direct market/vault/oracle integration
- add explicit signless session registration and validation if signless is required for v1
- preserve funding/liquidation ownership on-chain

## Short-Term Practical Decision

Until deployed programs, program IDs, and sponsor credentials exist:

- the current local engine can remain as `demo mode`
- but it must be described as demo mode only
- the production architecture must point to wallet + Sails + voucher/signless flow

## Next Code Step

The next correct implementation step is:

1. scaffold the actual Vara frontend provider layer
2. wire wallet readiness and connection UI
3. generate typed Sails clients from the market, vault, and oracle IDLs
4. replace the local session button with a real session-registration transaction path

