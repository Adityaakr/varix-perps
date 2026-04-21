# Gtest Report

## Goal
Verify the Phase 1 Varix contract slice with deterministic gtest coverage over the exposed public messages.

## Scope
- `contracts/margin-vault`
- `contracts/oracle-service`
- `contracts/perp-market`

## Commands
- `cargo test --manifest-path contracts/margin-vault/Cargo.toml`
- `cargo test --manifest-path contracts/oracle-service/Cargo.toml`
- `cargo test --manifest-path contracts/perp-market/Cargo.toml`

## Passing Results
- `margin-vault`: deposit, withdraw, authorize market, lock margin path.
- `oracle-service`: configure relayer, submit signed price, query stored quote.
- `perp-market`: open long, settle funding through the exposed recovery path, update price, liquidate, query position removal.

## Failures Fixed During Loop
- Sails `#[service]` impls require helper calls to reference the concrete service type instead of `Self`.
- Query methods need `#[export]` or they do not appear in the generated client/IDL.
- Event enums need the `#[sails_rs::event]` marker.
- Mutable borrow overlap in vault and market close logic required scoped updates.
- Generated client tests must use generated DTOs and actor construction instead of assuming cloneable program actors.
- gtest balances for the market owner had to be increased to cover scheduled work and repeated calls.

## Residual Risk
- Autonomous delayed self-scheduling remains implemented in `perp-market`, but the deterministic gtest currently validates the same funding/liquidation handlers through the owner recovery path rather than asserting the delayed message trigger itself. That scheduler-specific path should be revisited in a follow-up local-smoke or deeper gtest pass.
