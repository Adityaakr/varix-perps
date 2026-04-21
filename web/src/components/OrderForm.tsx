import { useState } from "react";
import type { MarketSnapshot } from "../types";
import { formatMoney } from "../lib/format";

type OrderFormProps = {
  disabledReason: string | null;
  market: MarketSnapshot | null;
  onSubmit: (input: {
    side: "long" | "short";
    notional: number;
    leverage: number;
    maxSlippageBps: number;
  }) => Promise<void>;
};

export function OrderForm({ disabledReason, market, onSubmit }: OrderFormProps) {
  const [side, setSide] = useState<"long" | "short">("long");
  const [notional, setNotional] = useState(1_000);
  const [leverage, setLeverage] = useState(5);
  const [submitting, setSubmitting] = useState(false);

  const estimatedMargin = leverage > 0 ? notional / leverage : 0;
  const mark = market ? Number(market.markPrice) : 0;

  async function handleSubmit() {
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
          <dd>{formatMoney(estimatedMargin, 2)} USDC</dd>
        </div>
        <div>
          <dt>Current Position</dt>
          <dd>0.0000 {market ? "ETH" : "COIN"}</dd>
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
          <dt>Max Slippage</dt>
          <dd>0.30%</dd>
        </div>
      </dl>
      <button className="trade-submit" disabled={submitting || !market || Boolean(disabledReason)} onClick={handleSubmit} type="button">
        {submitting ? "Submitting..." : "Place Order"}
      </button>
      <p className="panel-note">{disabledReason ?? "Signed market orders go through the selected runtime."}</p>
    </section>
  );
}
