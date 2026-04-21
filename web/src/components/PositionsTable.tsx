import type { PositionSnapshot } from "../types";
import { formatMoney, formatSignedMoney } from "../lib/format";

type PositionsTableProps = {
  positions: PositionSnapshot[];
  onClose: (asset: PositionSnapshot["asset"]) => Promise<void>;
};

export function PositionsTable({ positions, onClose }: PositionsTableProps) {
  return (
    <section className="positions-panel terminal-panel">
      <div className="panel-header terminal-header">
        <div className="terminal-tabs">
          <button className="terminal-tab is-active" type="button">Positions</button>
          <button className="terminal-tab" type="button">Open Orders</button>
          <button className="terminal-tab" type="button">Funding</button>
          <button className="terminal-tab" type="button">History</button>
        </div>
        <span className="muted-text">Live</span>
      </div>
      <div className="positions-table">
        <div className="positions-head">
          <span>Coin</span>
          <span>Side</span>
          <span>Size</span>
          <span>Entry Price</span>
          <span>Mark Price</span>
          <span>PnL</span>
          <span>Action</span>
        </div>
        {positions.length === 0 ? (
          <div className="positions-empty">No open positions for this market yet.</div>
        ) : (
          positions.map((position) => (
            <div className="positions-row" key={`${position.trader}-${position.asset}`}>
              <span>{position.asset}</span>
              <span className={position.side === "long" ? "positive" : "negative"}>{position.side}</span>
              <span>{formatMoney(position.size, 4)}</span>
              <span>${formatMoney(position.entryPrice, 1)}</span>
              <span>${formatMoney(position.notional, 1)}</span>
              <span className={Number(position.pnl) >= 0 ? "positive" : "negative"}>
                {formatSignedMoney(position.pnl)}
              </span>
              <button className="table-button" onClick={() => void onClose(position.asset)} type="button">
                Close
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
