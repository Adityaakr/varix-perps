# Feature Spec

## Problem
Varix currently supports two different realities:

- `demo` mode is end-to-end, but it runs on a local off-chain engine.
- `vara` mode already supports wallet connection, session registration, and signed Sails calls, but it does not yet use a real fungible collateral token or a fully on-chain leverage path.

The biggest functional gap is collateral ownership. `margin-vault` is still an internal accounting ledger, not a vault backed by a real demo USDC-like VFT. `perp-market` also does not yet lock, release, or slash vault collateral as part of the position lifecycle. The LP-backed leverage path exists only in the demo engine.

## User Goal
Ship a real Vara test flow where a trader can:

1. connect a wallet
2. mint demo USDC-like VFT by signing a transaction
3. deposit that VFT into on-chain collateral custody
4. open long or short leveraged positions against on-chain risk logic
5. close or get liquidated with collateral and PnL settled on-chain

In parallel, LPs should be able to deposit VFT liquidity into a pool that defines trade capacity and leverage backing, while the frontend shows positions, balances, and market changes with second-level freshness and a path toward higher-frequency UI updates.

## In Scope
- A dedicated demo collateral token program using the standard VFT path from `awesome-sails`.
- User-signed mint flow for demo collateral.
- On-chain vault custody and accounting for deposited collateral.
- On-chain LP pool or liquidity-manager accounting backed by the same VFT.
- Cross-program wiring so market actions mutate vault and pool state instead of a demo-only HTTP engine.
- Frontend updates for wallet VFT balance, mint, deposit, withdraw, LP deposit, and leveraged trade execution.
- gtests for mint, deposit, LP funding, open, close, and liquidation.
- Initial indexer refactor plan so authoritative trading actions come from chain events, not local HTTP settlement.

## Out of Scope
- Mainnet-grade bridged USDC.
- Production bridge integrations.
- Advanced order types such as limit, stop, TP/SL, or conditional triggers.
- Full gas sponsorship and voucher issuance in this slice.
- A sub-millisecond matching engine or on-chain order book.

## Actors
- Trader
- LP
- Protocol owner / deployer
- Session key
- Oracle relayer
- Indexer / websocket consumers

## State Changes
- Mint demo VFT to a trader wallet.
- Transfer VFT from trader wallet into vault custody.
- Credit and debit vault free and locked collateral.
- Deposit and withdraw LP liquidity.
- Open leveraged position with vault margin lock and pool-cap checks.
- Add margin, close position, settle PnL, and liquidate.
- Emit token, vault, pool, and market events for indexing.

## Messages And Replies
- `DemoUsdcVft`: standard VFT surface plus privileged or faucet-style `mint`.
- `MarginVault`: `deposit_vft`, `withdraw_vft`, `lock_margin`, `release_margin`, `slash_for_liquidation`, balance and totals queries.
- `LiquidityPool`: `deposit_liquidity`, `withdraw_liquidity`, `reserve_notional`, `release_notional`, pool queries, LP share queries.
- `PerpMarket`: `open_position`, `add_margin`, `close_position`, `settle_funding`, `check_liquidation`, plus position and market queries.
- `SessionRegistry`: existing bounded session registration and validation routes continue to govern delegated actions.

## Events
- Standard VFT `Transfer` and `Approval`.
- Demo mint event if a separate event is required by the chosen token stack.
- Vault deposit, withdrawal, lock, release, and slash events.
- LP deposit, withdrawal, reserve, release, and utilization events.
- Market position, funding, and liquidation events.

## Invariants
- Collateral balances must be backed by real VFT balances, not only internal ledger writes.
- A market cannot open or enlarge exposure without enough user margin and enough pool-backed capacity.
- Locked collateral cannot be withdrawn while supporting an open position.
- Liquidation and close flows must converge on a single source of truth for remaining margin and realized PnL.
- The indexer is read-only for authoritative state after this slice.
- Session permissions remain explicit and bounded by expiry.

## Edge Cases
- Trader signs `mint` successfully but does not deposit.
- Deposit transfer succeeds but vault credit fails.
- Session signer is valid for trading but not for withdrawal.
- LP liquidity becomes insufficient for new leveraged exposure while existing positions remain open.
- Funding accrual changes equity near the liquidation boundary.
- Partial close and liquidation interact around the same block window.
- Frontend market-data freshness exceeds chain-event freshness.

## Acceptance Criteria
- A demo collateral VFT exists as a standard Sails-compatible token program with generated IDL and client artifacts.
- A trader can mint demo VFT by signing a wallet transaction.
- A trader can deposit demo VFT into on-chain vault custody and later withdraw free collateral.
- Opening a leveraged position locks collateral through the vault and checks available LP-backed capacity before position creation.
- Closing or liquidating a position releases or slashes collateral through the vault and updates market and pool state consistently.
- The frontend exposes wallet balance, vault balance, LP actions, and leveraged trade actions through signed transactions with clear pending, success, and error states.
- gtests cover mint -> deposit -> open -> close and mint -> deposit -> liquidation paths.
- The demo HTTP engine no longer acts as the source of truth for Vara-mode trading actions.
