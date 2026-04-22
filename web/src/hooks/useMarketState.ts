import { useCallback, useEffect, useMemo, useState } from "react";
import { INDEXER_HTTP_URL, INDEXER_WS_URL } from "../lib/config";
import type { EngineSnapshot, MarketSnapshot } from "../types";

export function useMarketState(asset: MarketSnapshot["asset"], sessionToken: string | null) {
  const [snapshot, setSnapshot] = useState<EngineSnapshot>({
    markets: [],
    positions: [],
    fundingHistory: [],
    insuranceFund: "0.00",
    liquidityPool: {
      totalLiquidity: "0.00",
      maxOpenNotional: "0.00",
      reservedNotional: "0.00"
    },
    account: null,
    session: null
  });

  const applySnapshot = useCallback((next: EngineSnapshot) => {
    setSnapshot(next);
  }, []);

  useEffect(() => {
    if (!sessionToken) {
      return;
    }

    let active = true;
    const wsUrl = new URL(INDEXER_WS_URL);
    if (sessionToken) {
      wsUrl.searchParams.set("sessionToken", sessionToken);
    }
    const socket = new WebSocket(wsUrl);

    socket.onmessage = (event) => {
      if (!active) {
        return;
      }
      const next = JSON.parse(event.data) as EngineSnapshot;
      setSnapshot(next);
    };

    const stateUrl = new URL(`${INDEXER_HTTP_URL}/api/state`);
    if (sessionToken) {
      stateUrl.searchParams.set("sessionToken", sessionToken);
    }

    void fetch(stateUrl)
      .then((response) => response.json())
      .then((next: EngineSnapshot) => {
        if (!active) {
          return;
        }
        setSnapshot(next);
      })
      .catch(() => {
        if (!active) {
          return;
        }
        setSnapshot((current) => current);
      });

    socket.onerror = () => {
      socket.close();
    };

    return () => {
      active = false;
      socket.close();
    };
  }, [sessionToken]);

  return useMemo(() => {
    const market = snapshot.markets.find((item) => item.asset === asset) ?? null;
    const positions = snapshot.positions.filter((item) => item.asset === asset);
    return { applySnapshot, market, positions, snapshot };
  }, [applySnapshot, asset, snapshot]);
}
