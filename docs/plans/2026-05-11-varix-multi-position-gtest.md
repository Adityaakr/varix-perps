# Gtest Report

## Goal
Verify the `perp-market` hedge-mode change that allows one trader to hold multiple isolated positions in the same market.

## Scope
- `contracts/perp-market`
- `web`

## Commands
- `cargo test --manifest-path contracts/perp-market/Cargo.toml`
- `pnpm typecheck`

## Passing Results
- `perp-market` now stores and returns multiple open positions per trader through `position_id` and `Positions(trader)`.
- Integrated gtest proves:
  trader opens a long and a short at the same time,
  targeted close removes only the selected short,
  liquidation clears the remaining under-margined long,
  session-key trading still opens and closes the owner position correctly.
- Web typecheck passed after switching the frontend to `onchainPositions` and position-targeted close actions.

## Failures Fixed During Loop
- The old single-slot `BTreeMap<ActorId, Position>` model prevented hedge mode and forced one-position UI assumptions.
- The checked-in frontend IDL snapshot had to be refreshed manually after the Rust client regenerated, otherwise the React hook still looked for the old `Position` query shape.

## Deployment Evidence
- BTC market stack deployed on Vara testnet with fresh program ids recorded in `web/.env.testnet.local`.
- Live testnet smoke on the deployed BTC market opened two positions for the same wallet (`id: 1` long and `id: 2` short), queried both through `Market/Positions`, then closed them individually until the position list was empty again.
