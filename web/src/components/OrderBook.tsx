import type { OrderBookLevel } from "../types";
import { formatMoney } from "../lib/format";

type OrderBookProps = {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  updatedAt: number | null;
};

export function OrderBook({ bids, asks, updatedAt }: OrderBookProps) {
  const visibleAsks = asks.slice(0, 10).reverse();
  const visibleBids = bids.slice(0, 10);
  const isEmpty = visibleBids.length === 0 && visibleAsks.length === 0;
  const topBid = visibleBids[0];
  const topAsk = visibleAsks.at(-1);
  const spread = topBid && topAsk ? topAsk.price - topBid.price : null;

  let askRunningTotal = 0;
  const askRows = visibleAsks.map((level) => {
    askRunningTotal += level.size * level.price;
    return {
      ...level,
      total: askRunningTotal
    };
  });

  let bidRunningTotal = 0;
  const bidRows = visibleBids.map((level) => {
    bidRunningTotal += level.size * level.price;
    return {
      ...level,
      total: bidRunningTotal
    };
  });

  return (
    <section className="orderbook-panel terminal-panel">
      <div className="panel-header terminal-header">
        <div className="terminal-tabs">
          <button className="terminal-tab is-active" type="button">Order Book</button>
          <button className="terminal-tab" type="button">Trades</button>
        </div>
        <span className="muted-text">{updatedAt ? new Date(updatedAt).toLocaleTimeString() : "waiting"}</span>
      </div>
      <div className="book-head">
        <span>Price</span>
        <span>Size (USDC)</span>
        <span>Total (USDC)</span>
      </div>
      {isEmpty ? (
        <div className="positions-empty">Waiting for Hyperliquid depth.</div>
      ) : null}
      <div className="book-ladder">
        {askRows.map((level) => (
          <div className="book-row is-ask" key={`ask-${level.price}`}>
            <span>{formatMoney(level.price, 1)}</span>
            <span>{formatMoney(level.size, 0)}</span>
            <span>{formatMoney(level.total, 0)}</span>
          </div>
        ))}
        <div className="book-spread">
          <span>Spread</span>
          <strong>{spread === null ? "-" : formatMoney(spread, 1)}</strong>
        </div>
        {bidRows.map((level) => (
          <div className="book-row is-bid" key={`bid-${level.price}`}>
            <span>{formatMoney(level.price, 1)}</span>
            <span>{formatMoney(level.size, 0)}</span>
            <span>{formatMoney(level.total, 0)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
