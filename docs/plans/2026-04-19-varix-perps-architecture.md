# Architecture Note

## Summary
Varix uses isolated Sails workspaces per on-chain program to avoid `sails-rs` feature unification bugs while keeping a shared `no_std` types crate for cross-program DTOs and math. Core risk logic lives inside `perp-market` v1, with supporting vault and oracle programs already separated and scheduler/control-plane programs scaffolded for later expansion.

## Program And Service Boundaries
- `contracts/shared`: asset enums, position/account DTOs, fixed-point helpers.
- `contracts/margin-vault`: collateral accounting and market authorization.
- `contracts/oracle-service`: signed relayer ingress and quote storage.
- `contracts/perp-market`: isolated market state, position lifecycle, funding math, delayed liquidation checks.
- `contracts/market-factory`: market registry and deployment metadata.
- `contracts/funding-scheduler` and `contracts/liquidation-manager`: configuration scaffolds for dedicated automation control planes in later slices.

## State Ownership
- Every program owns its own state via program-level `RefCell` storage passed into services.
- Cross-program shared DTOs stay in `contracts/shared` with no `sails-rs` dependency.
- `perp-market` owns live position and risk state; `margin-vault` owns collateral balances; `oracle-service` owns trusted quotes.

## Message Flow
- Oracle relayer submits signed prices into `oracle-service`.
- Off-chain orchestration or future cross-program integration updates each `perp-market` mark/index from trusted oracle data.
- Traders deposit accounting balance into `margin-vault`, then open positions in `perp-market`.
- `perp-market` self-schedules `settle_funding` and per-trader `check_liquidation` delayed messages.

## Routing And Public Interface
- Existing public routes that must remain stable
None yet; this is a greenfield release.
- New routes introduced by this release
Vault, oracle, market, factory, funding scheduler, and liquidation manager services as defined in the spec.
- Any intentionally deprecated routes
None.
- Whether any method signature or reply shape changes are proposed
No; current work establishes the v1 surface.

## Event Contract
- Existing events that must remain stable
None yet.
- Any new event surface introduced by this release
Vault balance events, oracle submissions, position/funding/liquidation events, and market registry events.
- Whether any existing event payload changes are proposed
No.
- Whether event versioning is required
Not in v1.

## Generated Client Or IDL Impact
- Does this release require IDL regeneration
Yes, every contract workspace uses the standard Sails build path to emit IDL and generated clients.
- Which clients, scripts, or tools consume the IDL
Rust gtest harnesses first, then the planned TypeScript trading terminal and services.
- Whether old and new generated clients must coexist during cutover
Not applicable yet.

## Contract Version And Status Surface
- How the contract exposes version information
Versioning is implicit in workspace/package version for now; explicit on-chain version routes can be added in the next slice.
- Whether the contract has lifecycle status such as `Active` or `ReadOnly`
Not yet.
- Whether old-version writes must be disabled after cutover
Not applicable yet.

## Off-Chain Components
- Frontend program-id and config impact
Frontend config will map asset symbols to factory-registered market IDs plus vault/oracle program IDs.
- Indexer subscription or decoder impact
Indexer must consume the new event surfaces from vault, oracle, and markets.
- Any automation or scripts affected by the new version
Oracle relay and liquidation watcher will target the v1 route names.

## Release And Cutover Plan
- Deploy order
Deploy vault, oracle, factory, then each isolated market.
- Frontend switch strategy
Read program IDs from environment config keyed by asset.
- Indexer switch strategy
Subscribe to the configured program IDs after deployment.
- Whether the old version remains queryable
Not applicable yet.
- Whether writes to the old version are disabled
Not applicable yet.

## Failure And Recovery Paths
- Rollback target
Redeploy individual isolated markets without disturbing other assets.
- How to revert frontend and indexer back to the previous version
Repoint config to prior program IDs.
- What happens if the new version is deployed but not adopted
Programs remain inert until frontend and services reference them.

## Open Questions
- Whether `perp-market` should pull quotes from `oracle-service` directly in-program or continue with an owner/relayer-fed sync step.
- How much of the vault lock/release flow should move on-chain through direct program-to-program calls in the next slice versus staying behind off-chain orchestration temporarily.
- Whether market deployment in `market-factory` should use direct child program creation immediately or after the v1 market interface stabilizes.
