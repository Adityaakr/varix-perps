import { useState } from "react";
import type { PositionSnapshot } from "../types";
import { formatMoney, formatSignedMoney } from "../lib/format";

const PRICE_SCALE = 100_000_000n;
const PRICE_TO_COLLATERAL_SCALE = 100n;
const COLLATERAL_DECIMALS = 6;
const SIZE_DECIMALS = 8;
const PRICE_DECIMALS = 8;

type PositionsTableProps = {
  liveMarkPrice: number | null;
  positions: PositionSnapshot[];
  onClose: (asset: PositionSnapshot["asset"]) => Promise<void>;
};

function decimalToUnits(value: string | number, decimals: number): bigint | null {
  const raw = typeof value === "number" ? value.toFixed(decimals) : value;
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const negative = trimmed.startsWith("-");
  const unsigned = negative || trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  if (!/^\d+$/.test(whole || "0") || !/^\d*$/.test(fraction)) {
    return null;
  }

  const units = BigInt(whole || "0") * 10n ** BigInt(decimals)
    + BigInt(fraction.padEnd(decimals, "0").slice(0, decimals) || "0");
  return negative ? -units : units;
}

function unitsToNumber(value: bigint, decimals: number) {
  return Number(value) / 10 ** decimals;
}

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
          <span>Position</span>
          <span>Size</span>
          <span>Entry Price</span>
          <span>Mark Price</span>
          <span>Margin</span>
          <span>Lev</span>
          <span>PnL</span>
          <span>Action</span>
        </div>
        {positions.length === 0 ? (
          <div className="positions-empty">No open positions for this market yet.</div>
        ) : (
          positions.map((position) => (
            (() => {
              const sizeUnits = decimalToUnits(position.size, SIZE_DECIMALS);
              const entryUnits = decimalToUnits(position.entryPrice, PRICE_DECIMALS);
              const snapshotMarkUnits = decimalToUnits(position.markPrice, PRICE_DECIMALS);
              const liveMarkUnits = liveMarkPrice === null ? null : decimalToUnits(liveMarkPrice, PRICE_DECIMALS);
              const markUnits = liveMarkUnits ?? snapshotMarkUnits;
              const markPrice = markUnits === null ? Number(position.markPrice) : unitsToNumber(markUnits, PRICE_DECIMALS);
              const entryPrice = entryUnits === null ? Number(position.entryPrice) : unitsToNumber(entryUnits, PRICE_DECIMALS);
              const signedSizeUnits = position.side === "long" ? sizeUnits : sizeUnits === null ? null : -sizeUnits;
              const notionalUnits = sizeUnits === null || markUnits === null
                ? null
                : sizeUnits * markUnits / PRICE_SCALE / PRICE_TO_COLLATERAL_SCALE;
              const pnlUnits = signedSizeUnits === null || entryUnits === null || markUnits === null
                ? null
                : signedSizeUnits * (markUnits - entryUnits) / PRICE_SCALE / PRICE_TO_COLLATERAL_SCALE;
              const notional = notionalUnits === null ? Number(position.notional) : unitsToNumber(notionalUnits, COLLATERAL_DECIMALS);
              const pnl = pnlUnits === null ? Number(position.pnl) : unitsToNumber(pnlUnits, COLLATERAL_DECIMALS);

              return (
                <div className="positions-row" key={`${position.trader}-${position.asset}`}>
                  <span>{position.asset}</span>
                  <span className={position.side === "long" ? "positive" : "negative"}>{position.side}</span>
                  <span>${formatMoney(notional, 2)}</span>
                  <span>{formatMoney(position.size, 6)} {position.asset}</span>
                  <span>${formatMoney(entryPrice, 1)}</span>
                  <span>${formatMoney(markPrice, 1)}</span>
                  <span>${formatMoney(position.margin, 2)}</span>
                  <span>{position.leverage}x</span>
                  <span className={pnl >= 0 ? "positive" : "negative"}>
                    {formatSignedMoney(pnl)}
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
