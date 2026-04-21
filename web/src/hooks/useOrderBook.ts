import { useEffect, useState } from "react";
import { HYPERLIQUID_INFO_URL, HYPERLIQUID_WS_URL } from "../lib/config";
import type { Asset, OrderBookLevel, OrderBookSnapshot } from "../types";

type HyperliquidBook = {
  levels?: [
    Array<{ px: string; sz: string }>,
    Array<{ px: string; sz: string }>
  ];
  time?: number;
};

function toSnapshot(asset: Asset, payload: HyperliquidBook): OrderBookSnapshot {
  const [bids = [], asks = []] = payload.levels ?? [[], []];
  return {
    asset,
    updatedAt: payload.time ?? Date.now(),
    bids: bids.map<OrderBookLevel>((level) => ({
      price: Number(level.px),
      size: Number(level.sz)
    })),
    asks: asks.map<OrderBookLevel>((level) => ({
      price: Number(level.px),
      size: Number(level.sz)
    }))
  };
}

export function useOrderBook(asset: Asset): { bids: OrderBookLevel[]; asks: OrderBookLevel[]; updatedAt: number | null } {
  const [book, setBook] = useState<OrderBookSnapshot | null>(null);

  useEffect(() => {
    let active = true;
    let heartbeatId: number | null = null;
    let reconnectId: number | null = null;

    void fetch(HYPERLIQUID_INFO_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        type: "l2Book",
        coin: asset
      })
    })
      .then((response) => response.json())
      .then((payload: HyperliquidBook) => {
        if (active) {
          setBook(toSnapshot(asset, payload));
        }
      })
      .catch(() => {
        if (active) {
          setBook(null);
        }
      });

    function connect() {
      const socket = new WebSocket(HYPERLIQUID_WS_URL);

      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            method: "subscribe",
            subscription: {
              type: "l2Book",
              coin: asset
            }
          })
        );

        heartbeatId = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ method: "ping" }));
          }
        }, 30_000);
      };

      socket.onmessage = (event) => {
        const payload = JSON.parse(event.data) as {
          channel?: string;
          data?: HyperliquidBook;
        };
        if (!active || payload.channel !== "l2Book" || !payload.data) {
          return;
        }
        setBook(toSnapshot(asset, payload.data));
      };

      socket.onclose = () => {
        if (heartbeatId !== null) {
          window.clearInterval(heartbeatId);
          heartbeatId = null;
        }
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
      if (heartbeatId !== null) {
        window.clearInterval(heartbeatId);
      }
      if (reconnectId !== null) {
        window.clearTimeout(reconnectId);
      }
      socket.close();
    };
  }, [asset]);

  return {
    bids: book?.bids ?? [],
    asks: book?.asks ?? [],
    updatedAt: book?.updatedAt ?? null
  };
}
