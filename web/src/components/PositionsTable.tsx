import { useState } from "react";
import type { PositionSnapshot } from "../types";
import { formatMoney, formatSignedMoney } from "../lib/format";

type PositionsTableProps = {
  liveMarkPrice: number | null;
  positions: PositionSnapshot[];
  onClose: (asset: PositionSnapshot["asset"]) => Promise<void>;
};

export function PositionsTable({ liveMarkPrice, positions, onClose }: PositionsTableProps) {
  const [closingAsset, setClosingAsset] = useState<PositionSnapshot["asset"] | null>(null);

  async function handleClose(asset: PositionSnapshot["asset"]) {
    setClosingAsset(asset);
    try {
      await onClose(asset);
    } finally {
      setClosingAsset(null);
    }
  }

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
            (() => {
              const size = Number(position.size);
              const entryPrice = Number(position.entryPrice);
              const markPrice = liveMarkPrice ?? entryPrice;
              const livePnl = position.side === "long"
                ? size * (markPrice - entryPrice)
                : size * (entryPrice - markPrice);

              return (
                <div className="positions-row" key={`${position.trader}-${position.asset}`}>
                  <span>{position.asset}</span>
                  <span className={position.side === "long" ? "positive" : "negative"}>{position.side}</span>
                  <span>{formatMoney(position.size, 4)}</span>
                  <span>${formatMoney(entryPrice, 1)}</span>
                  <span>${formatMoney(markPrice, 1)}</span>
                  <span className={livePnl >= 0 ? "positive" : "negative"}>
                    {formatSignedMoney(livePnl)}
                  </span>
                  <button
                    className="table-button"
                    disabled={closingAsset !== null}
                    onClick={() => void handleClose(position.asset)}
                    type="button"
                  >
                    {closingAsset === position.asset ? "Closing..." : "Close"}
                  </button>
                </div>
              );
            })()
          ))
        )}
      </div>
    </section>
  );
}
