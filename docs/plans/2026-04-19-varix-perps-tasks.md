# Task Plan

## Goal
Stand up the Varix repo in a production-oriented shape and complete the first on-chain implementation slice for core risk primitives.

## Preconditions
- Rust stable with `wasm32-unknown-unknown` and `wasm32v1-none` targets.
- `sails-rs` dependencies available through Cargo.
- Later slices will still need `cargo-sails` and `gear` installed cleanly for a fully standard local dev loop.

## Ordered Tasks
1. Scaffold isolated contract workspaces plus shared types crate.
2. Implement vault, oracle, perp market, and market registry logic.
3. Add funding/liquidation control-plane scaffolds.
4. Add gtest coverage for public message paths and delayed self-message flows.
5. Scaffold `services/` and `web/` workspaces with strict TypeScript defaults.
6. Write setup and demo documentation.

## Dependencies
- `oracle-service` depends on no other contract state.
- `perp-market` depends on shared math/types and eventual oracle/vault integration.
- Frontend and services depend on emitted IDLs and program IDs.

## Verification Steps
- `cargo test` in each implemented contract workspace.
- Confirm delayed funding/liquidation routes are encoded with Sails route prefixes.
- Confirm generated client build steps produce IDL/client artifacts.

## Review Checkpoints
- Revisit direct cross-program vault/oracle integration after core math is green.
- Add explicit on-chain version/status surfaces before testnet deployment.
- Replace registry-only factory behavior with actual child deployment once program creation flow is locked.

## Rollback Notes
- Each market is isolated, so regressions can be rolled back per program ID.
- Shared crate changes require rebuilding every dependent contract workspace.
