import { useEffect, useState } from "react";
import { HYPERLIQUID_INFO_URL, HYPERLIQUID_WS_URL } from "../lib/config";
import type { Asset, Candle } from "../types";

function getLookbackWindow(interval: string) {
  switch (interval) {
    case "1m":
      return 1000 * 60 * 60 * 8;
    case "5m":
      return 1000 * 60 * 60 * 24;
    case "15m":
      return 1000 * 60 * 60 * 24 * 3;
    case "1h":
      return 1000 * 60 * 60 * 24 * 7;
    default:
      return 1000 * 60 * 60 * 24;
  }
}

export function useCandles(asset: Asset, interval = "1h") {
  const [candles, setCandles] = useState<Candle[]>([]);

  useEffect(() => {
    let active = true;
    let heartbeatId: number | null = null;
    let reconnectId: number | null = null;

    const endTime = Date.now();
    const startTime = endTime - getLookbackWindow(interval);

    void fetch(HYPERLIQUID_INFO_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        type: "candleSnapshot",
        req: {
          coin: asset,
          interval,
          startTime,
          endTime
        }
      })
    })
      .then((response) => response.json())
      .then((payload: Candle[]) => {
        if (active) {
          setCandles(payload);
        }
      })
      .catch(() => {
        if (active) {
          setCandles([]);
        }
      });

    function connect() {
      const socket = new WebSocket(HYPERLIQUID_WS_URL);

      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            method: "subscribe",
            subscription: {
              type: "candle",
              coin: asset,
              interval
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
          data?: Candle | Candle[];
        };
        if (!active || payload.channel !== "candle" || !payload.data) {
          return;
        }

        const updates = Array.isArray(payload.data) ? payload.data : [payload.data];
        setCandles((current) => {
          const next = [...current];
          for (const candle of updates) {
            const existingIndex = next.findIndex((item) => item.t === candle.t);
            if (existingIndex >= 0) {
              next[existingIndex] = candle;
            } else {
              next.push(candle);
            }
          }
          next.sort((left, right) => left.t - right.t);
          return next.slice(-240);
        });
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
  }, [asset, interval]);

  return candles;
}
