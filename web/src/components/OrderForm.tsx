import { useState } from "react";
import type { MarketSnapshot, PositionSnapshot } from "../types";
import { describeActionError } from "../lib/errors";
import { formatMoney } from "../lib/format";

type OrderFormProps = {
  asset: MarketSnapshot["asset"];
  availableCollateral: number;
  availableNotional: number;
  openPositions: PositionSnapshot[];
  disabledReason: string | null;
  market: MarketSnapshot | null;
  /** On-chain taker fee in basis points (perp-market `fee_config`). Defaults to 0. */
  takerFeeBps?: number;
  onSubmit: (input: {
    side: "long" | "short";
    notional: number;
    leverage: number;
    maxSlippageBps: number;
  }) => Promise<void>;
};

export function OrderForm({
  asset,
  availableCollateral,
  availableNotional,
  openPositions,
  disabledReason,
  market,
  takerFeeBps = 0,
  onSubmit
}: OrderFormProps) {
  const [side, setSide] = useState<"long" | "short">("long");
  const [notional, setNotional] = useState(1_000);
  const [leverage, setLeverage] = useState(5);
  const [maxSlippageBps, setMaxSlippageBps] = useState(30);
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const netPosition = openPositions.find((position) => position.asset === asset) ?? null;
  const netPositionNotional = netPosition ? Number(netPosition.notional) : 0;
  const netPositionMargin = netPosition ? Number(netPosition.margin) : 0;
  const isOppositeSideOrder = Boolean(netPosition && netPosition.side !== side);
  const reducedNotional = isOppositeSideOrder ? Math.min(notional, netPositionNotional) : 0;
  const incrementalNotional = isOppositeSideOrder
    ? Math.max(0, notional - netPositionNotional)
    : notional;
  const estimatedMargin = leverage > 0 ? incrementalNotional / leverage : 0;
  const releasedMargin = netPositionNotional > 0
    ? Math.min(netPositionMargin, netPositionMargin * (reducedNotional / netPositionNotional))
    : 0;
  const marginLabel = isOppositeSideOrder && incrementalNotional === 0
    ? "No new margin"
    : `$${formatMoney(estimatedMargin)}`;
  const marginHint = isOppositeSideOrder
    ? incrementalNotional > 0
      ? `Closes ${formatMoney(netPositionNotional, 2)} USDC, opens ${formatMoney(incrementalNotional, 2)} USDC ${side}.`
      : `Reduces ${formatMoney(reducedNotional, 2)} USDC and releases about ${formatMoney(releasedMargin, 2)} USDC.`
    : null;
  const mark = market ? Number(market.markPrice) : 0;
  // Taker fee charged on the incremental notional that actually opens (the
  // on-chain perp-market charges its fee on opened notional).
  const estimatedFee = (incrementalNotional * takerFeeBps) / 10_000;
  // Estimated liquidation price for the opening leg. Simple leverage-based
  // estimate (entry fills at mark; maintenance margin pulls the real level
  // slightly closer), shown only when the order actually adds exposure.
  const estimatedLiquidationPrice = incrementalNotional > 0 && leverage > 0 && mark > 0
    ? side === "long"
      ? mark * (1 - 1 / leverage)
      : mark * (1 + 1 / leverage)
    : null;
  const orderIntent = netPosition
    ? netPosition.side === side
      ? `Adds to existing ${side}`
      : incrementalNotional > 0
        ? `Reduces ${netPosition.side}, flips ${side}`
        : `Reduces existing ${netPosition.side}`
    : `Opens new ${side}`;

  async function handleSubmit() {
    if (disabledReason) {
      setValidationError(disabledReason);
      return;
    }
    if (!market) {
      setValidationError("Market data is still loading.");
      return;
    }
    if (!Number.isFinite(notional) || notional < 100) {
      setValidationError("Enter an order value of at least 100 USDC.");
      return;
    }
    if (!Number.isFinite(leverage) || leverage < 1 || leverage > 20) {
      setValidationError("Choose leverage between 1x and 20x.");
      return;
    }
    if (availableCollateral <= 0 && estimatedMargin > 0) {
      setValidationError("Deposit collateral before opening a position.");
      return;
    }
    if (estimatedMargin > availableCollateral) {
      setValidationError(
        `Margin required is ${formatMoney(estimatedMargin, 2)} USDC, but only ${formatMoney(availableCollateral, 2)} USDC is free.`
      );
      return;
    }
    if (availableNotional <= 0 && incrementalNotional > 0) {
      setValidationError("Fund LP before trading. The pool has no available capacity yet.");
      return;
    }
    if (notional > availableNotional) {
      if (incrementalNotional <= availableNotional) {
        setValidationError(null);
      } else {
        setValidationError(
          `Order value exceeds pool capacity. Max available notional is ${formatMoney(availableNotional, 2)} USDC.`
        );
        return;
      }
    } else if (incrementalNotional > availableNotional) {
      setValidationError(
        `Order value exceeds pool capacity. Max available notional is ${formatMoney(availableNotional, 2)} USDC.`
      );
      return;
    }

    setValidationError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        side,
        notional,
        leverage,
        maxSlippageBps
      });
    } catch (error) {
      setValidationError(describeActionError(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="order-panel terminal-panel">
      <div className="trade-mode-strip">
        <button className="chip-button is-active" type="button">Isolated</button>
        <button className="chip-button" type="button">{leverage}x</button>
        <button className="chip-button" type="button">Classic</button>
      </div>
      <div className="terminal-tabs trade-tabs">
        <button className="terminal-tab is-active" type="button">Market</button>
        <button className="terminal-tab" type="button">Limit</button>
        <button className="terminal-tab" type="button">Pro</button>
      </div>
      <div className="toggle-group trade-side-toggle">
        <button className={side === "long" ? "active-long" : ""} onClick={() => setSide("long")} type="button">
          Buy / Long
        </button>
        <button className={side === "short" ? "active-short" : ""} onClick={() => setSide("short")} type="button">
          Sell / Short
        </button>
      </div>
      <dl className="trade-balance-grid">
        <div>
          <dt>Available to Trade</dt>
          <dd>{formatMoney(availableCollateral, 2)} USDC</dd>
        </div>
        <div>
          <dt>Open Positions</dt>
          <dd>{netPosition ? `${netPosition.side} ${formatMoney(netPosition.size, 6)} ${asset}` : `0 open on ${market ? asset : "COIN"}`}</dd>
        </div>
      </dl>
      <label className="field">
        <span>Order Value</span>
        <div className="field-shell">
          <input min={100} onChange={(event) => setNotional(Number(event.target.value))} type="number" value={notional} />
          <em>USDC</em>
        </div>
      </label>
      <label className="field">
        <span>Leverage</span>
        <input max={20} min={1} onChange={(event) => setLeverage(Number(event.target.value))} type="range" value={leverage} />
        <strong className="range-value">{leverage}x</strong>
      </label>
      <label className="field">
        <span>Max Slippage</span>
        <div className="field-shell">
          <input
            min={1}
            max={1000}
            onChange={(event) => setMaxSlippageBps(Math.max(0, Number(event.target.value)))}
            type="number"
            value={maxSlippageBps}
          />
          <em>bps</em>
        </div>
      </label>
      <div className="trade-checkboxes">
        <label><input type="checkbox" /> Reduce Only</label>
        <label><input type="checkbox" /> Take Profit / Stop Loss</label>
      </div>
      <dl className="order-metrics">
        <div>
          <dt>Mark Price</dt>
          <dd>${formatMoney(mark, 1)}</dd>
        </div>
        <div>
          <dt>{isOppositeSideOrder ? "Margin Impact" : "Margin Required"}</dt>
          <dd>
            {marginLabel}
            {marginHint ? <span className="metric-subtext">{marginHint}</span> : null}
          </dd>
        </div>
        <div>
          <dt>Funding</dt>
          <dd>{market ? `${(market.fundingRateBps / 100).toFixed(2)} bps` : "-"}</dd>
        </div>
        <div>
          <dt>Est. Liq. Price</dt>
          <dd>{estimatedLiquidationPrice === null ? "-" : `$${formatMoney(estimatedLiquidationPrice, 1)}`}</dd>
        </div>
        <div>
          <dt>Est. Fee</dt>
          <dd>
            {`$${formatMoney(estimatedFee, 2)}`}
            <span className="metric-subtext">{`${(takerFeeBps / 100).toFixed(2)}% taker`}</span>
          </dd>
        </div>
        <div>
          <dt>Pool Capacity</dt>
          <dd>${formatMoney(availableNotional, 0)}</dd>
        </div>
      </dl>
      <button
        className={`trade-submit${side === "short" ? " trade-submit--short" : ""}`}
        disabled={submitting || !market || Boolean(disabledReason)}
        onClick={handleSubmit}
        type="button"
      >
        {submitting
          ? `Opening ${side}…`
          : side === "long"
            ? `Long ${asset}`
            : `Short ${asset}`}
      </button>
      <p className={`panel-note${validationError ? " is-error" : ""}`}>
        {validationError
          ?? disabledReason
          ?? `One-way mode is active. ${orderIntent}.`}
      </p>
    </section>
  );
}
