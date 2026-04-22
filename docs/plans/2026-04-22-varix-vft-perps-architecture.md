# Architecture Note

## Summary
This slice moves Varix from a hybrid demo/on-chain model toward a real Vara custody and leverage path.

The new source-of-truth split is:

- `demo-usdc-vft` owns fungible collateral balances
- `margin-vault` owns deposited collateral accounting and custody-facing balance state
- `liquidity-pool` owns LP capital, LP shares, and notional-capacity accounting
- `perp-market` owns positions, funding, liquidation checks, and market-level risk state
- `session-registry` continues to authorize delegated session-key actions
- the frontend signs transactions against deployed programs
- the indexer mirrors on-chain events for UX and history only

This is an additive architecture slice. It preserves the current demo runtime for local fallback while defining the real Vara execution path needed for end-to-end completion.

## Program And Service Boundaries
- `contracts/demo-usdc-vft`
  Standard VFT-compatible token for demo collateral using the smallest `awesome-sails` surface that supports metadata and mint.
- `contracts/margin-vault`
  Accepts deposited VFT, credits free collateral, locks and releases margin for authorized markets, and processes withdrawal of free collateral.
- `contracts/liquidity-pool`
  Accepts LP VFT deposits, tracks LP shares, and enforces capacity or reserve limits that back leveraged exposure.
- `contracts/perp-market`
  Owns isolated positions, funding, and liquidation logic. It must call into the vault and pool during open, add-margin, close, and liquidation paths.
- `contracts/oracle-service`
  Remains the trusted quote store and relayer ingress path.
- `contracts/session-registry`
  Remains the session-key validation surface for trade, add-margin, and withdraw permissions.
- `services/indexer`
  Must evolve into a real event indexer and websocket fanout service. It should stop accepting authoritative trade commands in Vara mode.
- `services/market-data-proxy`
  Continues to provide high-frequency candles and order-book style market-data views for the frontend.

## State Ownership
- VFT wallet balances live only in the VFT program.
- Deposited free and locked collateral live in `margin-vault`.
- LP balances, shares, utilization, and available reserve live in `liquidity-pool`.
- Position state, funding state, and liquidation state live in each `perp-market`.
- Session binding and permission state live in `session-registry`.
- The indexer stores denormalized and historical views only.

## Message Flow
1. Trader connects wallet and optionally registers a session key.
2. Trader signs `Mint` on `demo-usdc-vft`.
3. Trader signs `deposit_vft` on `margin-vault`.
4. Vault verifies the token transfer or transfer authorization pattern, then credits free collateral.
5. LP signs `deposit_liquidity` on `liquidity-pool` using the same VFT.
6. Trader opens a position on `perp-market`.
7. `perp-market` validates session permissions, checks oracle-derived pricing and pool capacity, then locks trader collateral in `margin-vault` and reserves capacity in `liquidity-pool`.
8. On close, `perp-market` computes realized PnL and funding, releases or consumes locked collateral, and releases pool reservation.
9. On liquidation, `perp-market` triggers slash and reserve-release paths, then emits liquidation events.
10. Indexer consumes token, vault, pool, and market events and pushes normalized snapshots to the UI.

## Routing And Public Interface
- Existing public routes that must remain stable
  Existing `session-registry`, `oracle-service`, and current `perp-market` query surfaces should remain query-compatible where possible.
- New routes introduced by this release
  VFT mint and token routes, vault deposit/withdraw routes that are token-backed, LP deposit/withdraw and reserve routes, and market routes that invoke vault and pool integrations.
- Any intentionally deprecated routes
  Demo-engine HTTP trade settlement routes are deprecated for Vara mode but may remain for explicit `demo` runtime.
- Whether any method signature or reply shape changes are proposed
  Yes. `margin-vault` and `perp-market` will need additive or revised command surfaces so replies expose token-backed collateral and pool-backed exposure results.

## Event Contract
- Existing events that must remain stable
  `session-registry`, `oracle-service`, and current `perp-market` event payloads should remain stable unless explicitly versioned.
- Any new event surface introduced by this release
  Standard VFT events, token-backed vault events, LP share and utilization events, and market events that include collateral or pool side effects.
- Whether any existing event payload changes are proposed
  Prefer additive new events over mutating existing payloads in place.
- Whether event versioning is required
  Not initially, if new event types are additive and old payloads are preserved.

## Generated Client Or IDL Impact
- Does this release require IDL regeneration
  Yes, for the new VFT and LP programs and for any updated vault and market interfaces.
- Which clients, scripts, or tools consume the IDL
  Rust gtests, frontend runtime IDL parsing or generated clients, deployment scripts, and the future indexer decoder surface.
- Whether old and new generated clients must coexist during cutover
  Yes for the demo runtime; the frontend will need to preserve demo-only clients and Vara-mode clients during transition.

## Contract Version And Status Surface
- How the contract exposes version information
  Package version and documented deployment set for this slice; explicit on-chain version queries can be added later.
- Whether the contract has lifecycle status such as `Active` or `ReadOnly`
  Not yet, though the LP and market programs may later need `Paused` or `ReadOnly` lifecycle controls.
- Whether old-version writes must be disabled after cutover
  Demo-engine Vara writes should be disabled once the real Vara path is complete, but demo runtime can remain intentionally separate.

## Off-Chain Components
- Frontend program-id and config impact
  Add env vars for `VITE_DEMO_USDC_PROGRAM_ID` and `VITE_LIQUIDITY_POOL_PROGRAM_ID`, plus revised vault and market ID wiring.
- Indexer subscription or decoder impact
  The indexer must decode VFT, vault, LP, and market events and materialize trader balances, LP balances, positions, and utilization.
- Any automation or scripts affected by the new version
  Deployment scripts, seed scripts, and any smoke scripts must deploy the token before vault and pool initialization.

## Release And Cutover Plan
- Deploy order
  `session-registry` if needed, then `demo-usdc-vft`, `margin-vault`, `liquidity-pool`, `oracle-service`, and finally each isolated `perp-market`.
- Frontend switch strategy
  Keep `demo` and `vara` runtimes, but gate Vara mode on the full token + vault + pool + market config set rather than only vault + market IDs.
- Indexer switch strategy
  Start dual-reading during transition, then remove authoritative HTTP settlement for Vara mode once chain event indexing is stable.
- Whether the old version remains queryable
  Yes, demo runtime remains queryable and runnable as a separate mode.
- Whether writes to the old version are disabled
  Yes for Vara mode after cutover; no for explicit demo mode.

## Failure And Recovery Paths
- Rollback target
  Repoint frontend and indexer to the prior demo-only runtime or prior deployed program IDs.
- How to revert frontend and indexer back to the previous version
  Switch env configuration back to demo mode or prior program IDs and disable Vara mode gating.
- What happens if the new version is deployed but not adopted
  Programs remain inert except for direct test calls; demo runtime continues serving local flows.

## Open Questions
- Whether vault deposit should use `transfer` then notify, `approve` plus `transfer_from`, or a dedicated token-manager service pattern.
- Whether LP capacity should be modeled as total notional reserve, margin-backed insurance, or both.
- Whether trader realized PnL should settle directly against pool reserves in the first slice or through a separate insurance-accounting layer.
- Whether the frontend should keep runtime IDL parsing or move to fully generated TS clients after the new program surfaces stabilize.
