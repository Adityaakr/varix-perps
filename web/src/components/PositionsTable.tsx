import { useMemo, useState } from "react";
import { describeActionError } from "../lib/errors";
import { formatMoney, formatSignedMoney } from "../lib/format";
import type { MarketSnapshot, PositionSnapshot, RecentTrade } from "../types";

const PRICE_SCALE = 100_000_000n;
const PRICE_TO_COLLATERAL_SCALE = 100n;
const COLLATERAL_DECIMALS = 6;
const SIZE_DECIMALS = 8;
const PRICE_DECIMALS = 8;

type PositionsTableProps = {
  fundingRateBps: number | null;
  liveMarkPrice: number | null;
  market: MarketSnapshot | null;
  oraclePrice: number | null;
  positions: PositionSnapshot[];
  recentTrades: RecentTrade[];
  onClose: (position: PositionSnapshot) => Promise<void>;
};

type TabId = "positions" | "orders" | "funding" | "history";

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

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(timestamp);
}

function formatAge(timestamp: number) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 2) {
    return "live";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

export function PositionsTable({
  fundingRateBps,
  liveMarkPrice,
  market,
  oraclePrice,
  positions,
  recentTrades,
  onClose
}: PositionsTableProps) {
  const [activeTab, setActiveTab] = useState<TabId>("positions");
  const [closingPositionKey, setClosingPositionKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const livePositions = useMemo(() => {
    return positions.map((position) => {
      const sizeUnits = decimalToUnits(position.size, SIZE_DECIMALS);
      const entryUnits = decimalToUnits(position.entryPrice, PRICE_DECIMALS);
      const snapshotMarkUnits = decimalToUnits(position.markPrice, PRICE_DECIMALS);
      const marginUnits = decimalToUnits(position.margin, COLLATERAL_DECIMALS);
      const liquidationUnits = decimalToUnits(position.liquidationPrice, PRICE_DECIMALS);
      const liveMarkUnits = liveMarkPrice === null || position.asset !== market?.asset
        ? null
        : decimalToUnits(liveMarkPrice, PRICE_DECIMALS);
      const markUnits = liveMarkUnits ?? snapshotMarkUnits;
      const snapshotEntryPrice = entryUnits === null ? Number(position.entryPrice) : unitsToNumber(entryUnits, PRICE_DECIMALS);
      const sizeValue = Number(position.size);
      const marginValue = Number(position.margin);
      const derivedEntryPrice = sizeValue > 0 && marginValue > 0 && position.leverage > 0
        ? (marginValue * position.leverage) / sizeValue
        : null;
      const shouldUseDerivedEntry = derivedEntryPrice !== null
        && Math.abs(snapshotEntryPrice - 80_000) < 0.1
        && Math.abs(derivedEntryPrice - snapshotEntryPrice) / Math.max(snapshotEntryPrice, 1) > 0.005;
      const effectiveEntryUnits = shouldUseDerivedEntry
        ? decimalToUnits(derivedEntryPrice, PRICE_DECIMALS)
        : entryUnits;
      const signedSizeUnits = position.side === "long" ? sizeUnits : sizeUnits === null ? null : -sizeUnits;
      const notionalUnits = sizeUnits === null || markUnits === null
        ? null
        : sizeUnits * markUnits / PRICE_SCALE / PRICE_TO_COLLATERAL_SCALE;
      const pnlUnits = signedSizeUnits === null || effectiveEntryUnits === null || markUnits === null
        ? null
        : signedSizeUnits * (markUnits - effectiveEntryUnits) / PRICE_SCALE / PRICE_TO_COLLATERAL_SCALE;
      const markPrice = markUnits === null ? Number(position.markPrice) : unitsToNumber(markUnits, PRICE_DECIMALS);
      const entryPrice = effectiveEntryUnits === null
        ? snapshotEntryPrice
        : unitsToNumber(effectiveEntryUnits, PRICE_DECIMALS);
      const liquidationPrice = liquidationUnits === null
        ? Number(position.liquidationPrice)
        : unitsToNumber(liquidationUnits, PRICE_DECIMALS);
      const margin = marginUnits === null ? Number(position.margin) : unitsToNumber(marginUnits, COLLATERAL_DECIMALS);
      const notional = notionalUnits === null ? Number(position.notional) : unitsToNumber(notionalUnits, COLLATERAL_DECIMALS);
      const pnl = pnlUnits === null ? Number(position.pnl) : unitsToNumber(pnlUnits, COLLATERAL_DECIMALS);

      return {
        rawPosition: position,
        ...position,
        entryPrice,
        liquidationPrice,
        margin,
        markPrice,
        notional,
        pnl
      };
    });
  }, [liveMarkPrice, market?.asset, positions]);

  const latestTradeTimestamp = recentTrades[0]?.timestamp ?? market?.updatedAt ?? Date.now();
  const marketSpread = liveMarkPrice !== null && oraclePrice !== null ? liveMarkPrice - oraclePrice : null;
  const marketBasisBps = marketSpread !== null && oraclePrice && oraclePrice !== 0
    ? (marketSpread / oraclePrice) * 10_000
    : null;

  async function handleClose(position: PositionSnapshot) {
    if (position.id < 0) {
      setActionError("Position id is syncing. Close will unlock after Vara.eth preconfirmation.");
      return;
    }
    setClosingPositionKey(`${position.asset}:${position.id}`);
    setActionError(null);
    try {
      await onClose(position);
    } catch (error) {
      setActionError(describeActionError(error));
    } finally {
      setClosingPositionKey(null);
    }
  }

  return (
    <section className="positions-panel terminal-panel">
      <div className="panel-header terminal-header">
        <div className="terminal-tabs">
          <button className={`terminal-tab ${activeTab === "positions" ? "is-active" : ""}`} onClick={() => setActiveTab("positions")} type="button">Positions</button>
          <button className={`terminal-tab ${activeTab === "orders" ? "is-active" : ""}`} onClick={() => setActiveTab("orders")} type="button">Open Orders</button>
          <button className={`terminal-tab ${activeTab === "funding" ? "is-active" : ""}`} onClick={() => setActiveTab("funding")} type="button">Funding</button>
          <button className={`terminal-tab ${activeTab === "history" ? "is-active" : ""}`} onClick={() => setActiveTab("history")} type="button">History</button>
        </div>
        <span className="muted-text">Updated {formatAge(latestTradeTimestamp)}</span>
      </div>

      {activeTab === "positions" ? (
        <div className="positions-table">
          <div className="positions-live-strip">
            <span>Mark ${formatMoney(liveMarkPrice ?? market?.markPrice ?? 0, 1)}</span>
            <span>Oracle {oraclePrice === null ? "Waiting..." : `$${formatMoney(oraclePrice, 1)}`}</span>
            <span>Funding {fundingRateBps === null ? "Waiting..." : `${(fundingRateBps / 100).toFixed(2)} bps`}</span>
            <span>Last trade {formatTime(latestTradeTimestamp)}</span>
          </div>
          <div className="positions-head">
            <span>Coin</span>
            <span>Side</span>
            <span>Position</span>
            <span>Size</span>
            <span>Entry</span>
            <span>Mark</span>
            <span>Liq</span>
            <span>Margin</span>
            <span>PnL</span>
            <span>Action</span>
          </div>
          {livePositions.length === 0 ? (
            <div className="positions-empty">No open positions yet.</div>
          ) : (
            livePositions.map((position) => (
              <div className="positions-row" key={`${position.asset}:${position.id}`}>
                <span>{position.asset}</span>
                <span className={position.side === "long" ? "positive" : "negative"}>{position.side}</span>
                <span>${formatMoney(position.notional, 2)}</span>
                <span>{formatMoney(position.size, 6)} {position.asset}</span>
                <span>${formatMoney(position.entryPrice, 1)}</span>
                <span>${formatMoney(position.markPrice, 1)}</span>
                <span>${formatMoney(position.liquidationPrice, 1)}</span>
                <span>${formatMoney(position.margin, 2)}</span>
                <span className={position.pnl >= 0 ? "positive" : "negative"}>
                  {formatSignedMoney(position.pnl)}
                </span>
                <button
                  className="table-button"
                  disabled={closingPositionKey !== null || position.id < 0}
                  onClick={() => void handleClose(position.rawPosition)}
                  type="button"
                >
                  {position.id < 0
                    ? "Syncing"
                    : closingPositionKey === `${position.asset}:${position.id}`
                      ? "Closing..."
                      : "Close"}
                </button>
              </div>
            ))
          )}
          {actionError ? <div className="positions-empty is-error">{actionError}</div> : null}
        </div>
      ) : null}

      {activeTab === "orders" ? (
        <div className="positions-empty positions-detail-panel">
          No resting orders on this market. The current on-chain flow submits market entries and closes immediately rather than storing a limit order book in the contract.
        </div>
      ) : null}

      {activeTab === "funding" ? (
        <div className="positions-detail-panel">
          <div className="positions-metric-grid">
            <div>
              <span>Current Funding</span>
              <strong>{fundingRateBps === null ? "Waiting..." : `${(fundingRateBps / 100).toFixed(2)} bps`}</strong>
            </div>
            <div>
              <span>Cumulative Funding</span>
              <strong>{market ? `${(market.cumulativeFundingRateBps / 100).toFixed(2)} bps` : "-"}</strong>
            </div>
            <div>
              <span>Mark</span>
              <strong>${formatMoney(liveMarkPrice ?? market?.markPrice ?? 0, 1)}</strong>
            </div>
            <div>
              <span>Oracle</span>
              <strong>{oraclePrice === null ? "Waiting..." : `$${formatMoney(oraclePrice, 1)}`}</strong>
            </div>
            <div>
              <span>Spread</span>
              <strong className={marketSpread !== null && marketSpread >= 0 ? "positive" : "negative"}>
                {marketSpread === null ? "-" : formatSignedMoney(marketSpread)}
              </strong>
            </div>
            <div>
              <span>Basis</span>
              <strong className={marketBasisBps !== null && marketBasisBps >= 0 ? "positive" : "negative"}>
                {marketBasisBps === null ? "-" : `${marketBasisBps >= 0 ? "+" : ""}${formatMoney(marketBasisBps, 2)} bps`}
              </strong>
            </div>
          </div>
          <p className="panel-note">
            Funding is read from the live on-chain market snapshot. Mark uses the live market feed, oracle uses the separate oracle feed, and spread updates as those sources move.
          </p>
        </div>
      ) : null}

      {activeTab === "history" ? (
        <div className="positions-table">
          <div className="positions-head positions-head--history">
            <span>Time</span>
            <span>Side</span>
            <span>Price</span>
            <span>Size</span>
          </div>
          {recentTrades.length === 0 ? (
            <div className="positions-empty">No recent market prints yet.</div>
          ) : (
            recentTrades.slice(0, 24).map((trade, index) => (
              <div className="positions-row positions-row--history" key={`${trade.timestamp}-${trade.price}-${index}`}>
                <span>{formatTime(trade.timestamp)}</span>
                <span className={trade.side === "buy" ? "positive" : "negative"}>{trade.side}</span>
                <span>${formatMoney(trade.price, 1)}</span>
                <span>{formatMoney(trade.size, 4)} {trade.asset}</span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </section>
  );
}
