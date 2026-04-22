# Task Plan

## Goal
Complete the next implementation slice that turns Varix Vara mode into a real wallet-signed, VFT-backed leveraged trading flow with LP-backed capacity and an indexer that mirrors chain state instead of acting as the trading engine.

## Preconditions
- Rust and Sails toolchain remain green for the existing contract workspaces.
- `awesome-sails` dependency strategy is chosen and pinned intentionally.
- Existing `session-registry`, `margin-vault`, `perp-market`, and `oracle-service` tests remain passing before integration changes begin.
- Frontend env and program-id gating can be updated without breaking explicit `demo` mode.

## Ordered Tasks
1. Add a new `demo-usdc-vft` Sails workspace using the smallest `awesome-sails` token surface that supports metadata and controlled minting.
2. Write spec-level token decisions explicitly in the new workspace:
   token name, symbol, decimals, mint authority model, and whether minting is faucet-style or owner-routed for demo.
3. Add gtests for mint, transfer, and any required admin or faucet rules in `demo-usdc-vft`.
4. Introduce a new `liquidity-pool` Sails workspace for LP deposits, LP shares, and exposure-capacity accounting.
5. Refactor `margin-vault` from internal ledger-only deposit/withdraw into token-backed custody and accounting.
6. Wire `perp-market` to call vault lock/release/slash paths during open, add-margin, close, and liquidation flows.
7. Wire `perp-market` to call pool reserve and release paths so new exposure is bounded by LP liquidity.
8. Extend shared DTOs and events only where needed for token-backed settlement and LP visibility.
9. Add integrated gtests:
   mint -> deposit -> open -> close
   mint -> deposit -> open -> liquidation
   LP deposit -> trader open within cap
   reject open when LP capacity is insufficient
10. Update the frontend to show:
    wallet VFT balance, mint action, vault deposit and withdraw, LP deposit and withdraw, and position actions with signed transaction states.
11. Expand frontend runtime gating so Vara mode requires token, vault, pool, oracle, session, and market program IDs.
12. Refactor the indexer boundary:
    keep demo settlement only for `demo` mode, and start consuming Vara program events as the authoritative source for trader and LP state.
13. Add local smoke commands and deployment notes for the full deploy order.

## Dependencies
- `demo-usdc-vft` must exist before token-backed vault custody can be completed.
- `liquidity-pool` design must be settled before `perp-market` capacity checks are finalized.
- `margin-vault` integration must land before real leveraged trading can be considered complete.
- Frontend Vara mode should switch only after the new IDLs and program IDs exist.
- Indexer event decoding depends on the final event surfaces from token, vault, pool, and market.

## Verification Steps
- `cargo test --manifest-path contracts/demo-usdc-vft/Cargo.toml`
- `cargo test --manifest-path contracts/liquidity-pool/Cargo.toml`
- `cargo test --manifest-path contracts/margin-vault/Cargo.toml`
- `cargo test --manifest-path contracts/perp-market/Cargo.toml`
- End-to-end gtest proving token-backed deposit and leveraged lifecycle.
- Frontend manual smoke:
  connect wallet -> mint demo USDC -> deposit -> open long/short -> close -> verify balances refresh.
- Verify Vara mode no longer calls the demo HTTP settlement routes for deposit, withdraw, open, or close.
- Verify indexer-derived UI state matches on-chain queries for balances and positions.

## Review Checkpoints
- Confirm the token stack is still the smallest `awesome-sails` surface that satisfies demo collateral needs.
- Confirm no contract still treats internal ledger writes as a substitute for real token custody.
- Confirm pool-backed leverage limits are explicit and test-covered.
- Confirm the frontend distinguishes wallet readiness, token balance availability, and transaction-pending states clearly.
- Confirm demo mode remains explicit and does not silently masquerade as Vara mode.

## Rollback Notes
- If token-backed custody is unstable, keep demo mode as the primary runnable path while reverting Vara mode to query-only or session-only behavior.
- Because markets are isolated, deployment rollback can happen per program ID once the LP and vault dependencies are versioned clearly.
- Frontend rollback is configuration-driven: remove the new program IDs and force `demo` mode until the next cut.
