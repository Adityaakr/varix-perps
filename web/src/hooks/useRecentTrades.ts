import { useEffect, useState } from "react";
import { HYPERLIQUID_WS_URL } from "../lib/config";
import type { Asset, RecentTrade } from "../types";

type HyperliquidTrade = {
  coin?: string;
  px?: string | number;
  sz?: string | number;
  side?: string;
  time?: number;
};

function normalizeTrade(asset: Asset, trade: HyperliquidTrade): RecentTrade | null {
  const price = Number(trade.px);
  const size = Number(trade.sz);
  const side = String(trade.side ?? "").toLowerCase();

  if (!Number.isFinite(price) || !Number.isFinite(size)) {
    return null;
  }

  return {
    asset,
    price,
    size,
    side: side === "a" || side === "sell" ? "sell" : "buy",
    timestamp: trade.time ?? Date.now()
  };
}

export function useRecentTrades(asset: Asset) {
  const [trades, setTrades] = useState<RecentTrade[]>([]);

  useEffect(() => {
    let active = true;
    let reconnectId: number | null = null;

    function connect() {
      const socket = new WebSocket(HYPERLIQUID_WS_URL);

      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            method: "subscribe",
            subscription: {
              type: "trades",
              coin: asset
            }
          })
        );
      };

      socket.onmessage = (event) => {
        const payload = JSON.parse(event.data) as {
          channel?: string;
          data?: HyperliquidTrade | HyperliquidTrade[];
        };

        if (!active || payload.channel !== "trades" || !payload.data) {
          return;
        }

        const updates = (Array.isArray(payload.data) ? payload.data : [payload.data])
          .map((item) => normalizeTrade(asset, item))
          .filter((item): item is RecentTrade => item !== null);

        if (updates.length === 0) {
          return;
        }

        setTrades((current) => [...updates.reverse(), ...current].slice(0, 30));
      };

      socket.onclose = () => {
        if (active) {
          reconnectId = window.setTimeout(connect, 1200);
        }
      };

      socket.onerror = () => {
        socket.close();
      };

      return socket;
    }

    const socket = connect();

    return () => {
      active = false;
      if (reconnectId !== null) {
        window.clearTimeout(reconnectId);
      }
      socket.close();
    };
  }, [asset]);

  return trades;
}
