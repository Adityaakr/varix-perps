# Architecture

## Contract Model
- Store open positions by `position_id`.
- Maintain a secondary trader-to-position-id index for queries and liquidation sweeps.
- Keep margin custody unchanged in `margin-vault`: locked balance remains aggregate per trader, while `perp-market` tracks per-position margin allocation.

## Public Surface
- `OpenPosition` returns a position record with `id`, `trader`, and `position`.
- `AddMargin(position_id, amount)` updates one isolated position.
- `ClosePosition(position_id, size)` closes one isolated position partially or fully.
- `Positions(trader)` returns every open position in the market for that trader.

## Liquidation
- Delayed liquidation messages remain trader-scoped.
- Each liquidation check iterates that trader’s current position ids and liquidates only the positions that breach maintenance.
- Healthy positions remain open and are re-scheduled for later checks.
