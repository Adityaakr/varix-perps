# Feature Spec

## Problem
Vara lacks a Hyperliquid-style perps stack with on-chain autonomous risk controls, isolated market deployment, and a frontend that hides chain friction from active traders.

## User Goal
Ship a Vara-native perpetual DEX where a trader can bridge in collateral, trade BTC/ETH/SOL perps with leverage, and rely on on-chain funding plus liquidation automation instead of external keeper bots.

## In Scope
- Sails-based program set for isolated markets, collateral accounting, signed oracle ingress, market registry, and scheduler/control scaffolds.
- TypeScript services workspace for oracle relay, liquidation watcher, indexer, and market-data proxy.
- React trading terminal scaffold with wallet, chart, order entry, and live market surfaces.
- Documentation and plans for the phased build.

## Out of Scope
- Mainnet deployment hardening in this initial scaffold.
- Production bridge adapters to real bridged USDC contracts.
- Advanced order types beyond the initial market-entry and manual close path.

## Actors
- Trader
- Protocol owner / deployer
- Oracle relayer
- Indexer / data consumers
- Sponsor backend for gasless + signless sessions

## State Changes
- Collateral deposits, withdrawals, lock/release/slash operations.
- Oracle quote updates per asset.
- Position open, margin add, close, funding settlement, and liquidation.
- Market registry updates for isolated program IDs.

## Messages And Replies
- `MarginVault`: `deposit`, `withdraw`, `authorize_market`, `revoke_market`, `lock_margin`, `release_margin`, `slash_for_liquidation`, plus account/totals queries.
- `OracleService`: `configure_relayer`, `submit_price`, plus quote query.
- `PerpMarket`: `update_price`, `open_position`, `add_margin`, `close_position`, `settle_funding`, `check_liquidation`, plus state/config/position queries.
- `MarketFactory`: market code configuration and market registry routes.

## Events
- Vault balance and authorization events.
- Oracle relayer configuration and price submission events.
- Perp price, position, funding, and liquidation events.
- Market registry events.

## Invariants
- No floating point arithmetic on-chain.
- One isolated market program per asset.
- Funding and liquidation checks are schedulable on-chain through delayed self-messages.
- Only authorized relayers can update oracle state.
- Only authorized markets can mutate vault lock state.

## Edge Cases
- Stale oracle submissions.
- Delayed liquidation checks racing against manual close.
- Program delayed messages failing on-chain if the program account is unfunded.
- Partial close math and funding accrual around the close boundary.
- Voucher/session expiry during active frontend sessions.

## Acceptance Criteria
Phase 1 acceptance is a green contract scaffold with isolated Sails workspaces, implemented core business logic for vault/oracle/perp market, delayed funding/liquidation scheduling hooks, and tests that prove open, funding, and liquidation behavior in gtest.
