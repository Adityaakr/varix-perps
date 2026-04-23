import { useState } from "react";
import type { MarketSnapshot, PositionSnapshot } from "../types";
import { formatMoney } from "../lib/format";

const MAX_LEVERAGE = 50;

type OrderFormProps = {
  asset: MarketSnapshot["asset"];
  availableCollateral: number;
  availableNotional: number;
  currentPosition: PositionSnapshot | null;
  disabledReason: string | null;
  market: MarketSnapshot | null;
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
  currentPosition,
  disabledReason,
  market,
  onSubmit
}: OrderFormProps) {
  const [side, setSide] = useState<"long" | "short">("long");
  const [notional, setNotional] = useState(1_000);
  const [leverage, setLeverage] = useState(5);
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const hasExistingPosition = Boolean(currentPosition);
  const estimatedMargin = leverage > 0 ? notional / leverage : 0;
  const mark = market ? Number(market.markPrice) : 0;

  async function handleSubmit() {
    if (disabledReason) {
      setValidationError(disabledReason);
      return;
    }
    if (!market) {
      setValidationError("Market data is still loading.");
      return;
    }
    if (hasExistingPosition) {
      setValidationError(`The current market supports one open ${asset} position at a time. Close the existing ${currentPosition?.side ?? ""} first.`);
      return;
    }
    if (!Number.isFinite(notional) || notional < 100) {
      setValidationError("Enter an order value of at least 100 USDC.");
      return;
    }
    if (!Number.isFinite(leverage) || leverage < 1 || leverage > MAX_LEVERAGE) {
      setValidationError(`Choose leverage between 1x and ${MAX_LEVERAGE}x.`);
      return;
    }
    if (availableCollateral <= 0) {
      setValidationError("Deposit collateral before opening a position.");
      return;
    }
    if (estimatedMargin > availableCollateral) {
      setValidationError(
        `Margin required is ${formatMoney(estimatedMargin, 2)} USDC, but only ${formatMoney(availableCollateral, 2)} USDC is free.`
      );
      return;
    }
    if (availableNotional <= 0) {
      setValidationError("Fund LP before trading. The pool has no available capacity yet.");
      return;
    }
    if (notional > availableNotional) {
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
        maxSlippageBps: 30
      });
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
        <button className={side === "long" ? "active-long" : ""} disabled={hasExistingPosition} onClick={() => setSide("long")} type="button">
          Buy / Long
        </button>
        <button className={side === "short" ? "active-short" : ""} disabled={hasExistingPosition} onClick={() => setSide("short")} type="button">
          Sell / Short
        </button>
      </div>
      <dl className="trade-balance-grid">
        <div>
          <dt>Available to Trade</dt>
          <dd>{formatMoney(availableCollateral, 2)} USDC</dd>
        </div>
        <div>
          <dt>Current Position</dt>
          <dd>
            {currentPosition
              ? `${formatMoney(currentPosition.size, 4)} ${asset} ${currentPosition.side}`
              : `0.0000 ${market ? asset : "COIN"}`}
          </dd>
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
        <input max={MAX_LEVERAGE} min={1} onChange={(event) => setLeverage(Number(event.target.value))} type="range" value={leverage} />
        <strong className="range-value">{leverage}x</strong>
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
          <dt>Margin Required</dt>
          <dd>${formatMoney(estimatedMargin)}</dd>
        </div>
        <div>
          <dt>Funding</dt>
          <dd>{market ? `${(market.fundingRateBps / 100).toFixed(2)} bps` : "-"}</dd>
        </div>
        <div>
          <dt>Pool Capacity</dt>
          <dd>${formatMoney(availableNotional, 0)}</dd>
        </div>
      </dl>
      <button
        className={`trade-submit${side === "short" ? " trade-submit--short" : ""}`}
        disabled={submitting || !market || Boolean(disabledReason) || hasExistingPosition}
        onClick={handleSubmit}
        type="button"
      >
        {hasExistingPosition
          ? `Close ${asset} position first`
          : submitting
            ? `Opening ${side}…`
            : side === "long"
              ? `Long ${asset}`
              : `Short ${asset}`}
      </button>
      <p className={`panel-note${validationError ? " is-error" : ""}`}>
        {validationError
          ?? (hasExistingPosition
            ? `One open ${asset} position per wallet is supported on the current market contract. Use the Positions table below to close it before opening another long or short.`
            : disabledReason ?? "Signed market orders go through the selected runtime.")}
      </p>
    </section>
  );
}
