import { useEffect, useMemo, useState } from "react";
import { PYTH_HERMES_URL } from "../lib/config";
import type { Asset } from "../types";

export type OraclePriceSnapshot = {
  asset: Asset;
  price: number;
  updatedAt: number;
  source: "pyth";
};

type PythLatestPriceResponse = {
  parsed?: Array<{
    id?: string;
    price?: {
      price?: string;
      expo?: number;
      publish_time?: number;
    };
  }>;
};

const POLL_INTERVAL_MS = 2_000;

export const FEED_ID_BY_ASSET: Record<Asset, string> = {
  BTC: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  SOL: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"
};

function normalizeFeedId(value: string | undefined) {
  return String(value ?? "").toLowerCase().replace(/^0x/, "");
}

function normalizePrice(rawPrice: string | undefined, expo: number | undefined) {
  if (rawPrice === undefined || expo === undefined) {
    return null;
  }

  const price = Number(rawPrice) * 10 ** expo;
  return Number.isFinite(price) && price > 0 ? price : null;
}

function dedupeAssets(assets: Asset[]) {
  return Array.from(new Set(assets));
}

function buildPythUrl(assets: Asset[]) {
  const url = new URL(PYTH_HERMES_URL);
  url.searchParams.set("parsed", "true");
  for (const asset of assets) {
    url.searchParams.append("ids[]", FEED_ID_BY_ASSET[asset]);
  }
  return url;
}

function parsePythPrices(assets: Asset[], payload: PythLatestPriceResponse) {
  const byFeedId = new Map(
    payload.parsed?.map((item) => [normalizeFeedId(item.id), item]) ?? []
  );
  const updatedAt = Date.now();
  const prices: Partial<Record<Asset, OraclePriceSnapshot>> = {};

  for (const asset of assets) {
    const entry = byFeedId.get(normalizeFeedId(FEED_ID_BY_ASSET[asset])) ?? null;
    const price = normalizePrice(entry?.price?.price, entry?.price?.expo);
    if (price === null) {
      continue;
    }

    prices[asset] = {
      asset,
      price,
      updatedAt: entry?.price?.publish_time ? entry.price.publish_time * 1000 : updatedAt,
      source: "pyth"
    };
  }

  return prices;
}

export function usePolymarketOraclePrices(assets: Asset[]) {
  const assetKey = dedupeAssets(assets).join(",");
  const normalizedAssets = useMemo(
    () => assetKey.split(",").filter(Boolean) as Asset[],
    [assetKey]
  );
  const [snapshots, setSnapshots] = useState<Partial<Record<Asset, OraclePriceSnapshot>>>({});

  useEffect(() => {
    if (normalizedAssets.length === 0) {
      setSnapshots({});
      return;
    }

    let active = true;
    let pollId: number | null = null;
    let inFlightController: AbortController | null = null;

    async function fetchLatest() {
      inFlightController?.abort();
      const controller = new AbortController();
      inFlightController = controller;

      try {
        const response = await fetch(buildPythUrl(normalizedAssets), { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Pyth Hermes request failed with ${response.status}`);
        }

        const payload = await response.json() as PythLatestPriceResponse;
        const prices = parsePythPrices(normalizedAssets, payload);

        if (!active) {
          return;
        }

        setSnapshots((current) => ({ ...current, ...prices }));
      } catch (error) {
        if (!active) {
          return;
        }
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
      }
    }

    void fetchLatest();
    pollId = window.setInterval(() => {
      void fetchLatest();
    }, POLL_INTERVAL_MS);

    return () => {
      active = false;
      if (pollId !== null) {
        window.clearInterval(pollId);
      }
      inFlightController?.abort();
    };
  }, [assetKey, normalizedAssets]);

  return snapshots;
}

export function usePolymarketOraclePrice(asset: Asset) {
  const snapshots = usePolymarketOraclePrices([asset]);
  return snapshots[asset] ?? null;
}
