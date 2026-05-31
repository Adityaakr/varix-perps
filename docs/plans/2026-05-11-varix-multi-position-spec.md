# Spec

## Goal
Enable hedge-mode trading on each `perp-market` contract so one trader can hold multiple isolated long and short positions at the same time.

## Requirements
- Every `open_position` call creates a distinct position instead of replacing or rejecting an existing one.
- Every open position has a stable `position_id`.
- `close_position` must target a specific `position_id`.
- `add_margin` must target a specific `position_id`.
- Trader queries must return the full list of open positions for that trader in the market.
- Liquidation checks must evaluate all open positions owned by the trader.
- Open-interest accounting must continue to reflect the sum of all open long and short position sizes.

## Non-Goals
- Cross-margin.
- Netting or position merging.
- Multi-market portfolio liquidation.
- Order-book or matching-engine changes.
