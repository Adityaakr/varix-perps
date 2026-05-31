import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { OraclePriceSnapshot } from "../hooks/usePolymarketOraclePrice";
import type { Asset, MarketSnapshot } from "../types";
import { formatMoney } from "../lib/format";

const ASSET_LOGOS: Record<string, ReactNode> = {
  BTC: (
    <svg viewBox="0 0 32 32" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
      <g fill="none" fillRule="evenodd">
        <circle cx="16" cy="16" r="16" fill="#F7931A" />
        <path
          fill="#FFF"
          fillRule="nonzero"
          d="M23.19 14.02c.3-2.01-1.23-3.09-3.32-3.81l.68-2.72-1.66-.41-.66 2.65c-.44-.11-.89-.21-1.34-.31l.66-2.66-1.66-.41-.68 2.72c-.36-.08-.71-.16-1.06-.25l-.01-.01-2.29-.57-.44 1.77s1.23.28 1.2.3c.67.17.8.61.78.96l-.78 3.13c.05.01.1.03.17.06l-.17-.04-1.1 4.38c-.08.2-.29.51-.76.39.02.02-1.2-.3-1.2-.3l-.82 1.9 2.16.54c.4.1.8.21 1.18.31l-.68 2.75 1.66.41.68-2.73c.45.12.9.24 1.33.35l-.68 2.71 1.66.41.68-2.74c2.84.54 4.97.32 5.87-2.25.72-2.07-.04-3.26-1.53-4.04 1.09-.25 1.91-.97 2.13-2.45zm-3.81 5.35c-.51 2.07-3.99.95-5.12.67l.91-3.67c1.13.28 4.74.84 4.21 3zm.51-5.38c-.47 1.88-3.36.93-4.3.69l.83-3.33c.94.24 3.95.68 3.47 2.64z"
        />
      </g>
    </svg>
  ),
  ETH: (
    <svg viewBox="0 0 32 32" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
      <g fill="none" fillRule="evenodd">
        <circle cx="16" cy="16" r="16" fill="#627EEA" />
        <g fill="#FFF" fillRule="nonzero">
          <path fillOpacity=".602" d="M16.5 4v8.87l7.5 3.35z" />
          <path d="M16.5 4L9 16.22l7.5-3.35z" />
          <path fillOpacity=".602" d="M16.5 21.97v6.03L24 17.62z" />
          <path d="M16.5 28V21.97L9 17.62z" />
          <path fillOpacity=".2" d="M16.5 20.57l7.5-4.35-7.5-3.35z" />
          <path fillOpacity=".602" d="M9 16.22l7.5 4.35v-7.7z" />
        </g>
      </g>
    </svg>
  ),
  SOL: (
    <svg viewBox="0 0 32 32" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="sol-a" x1="3.5" y1="28" x2="28.5" y2="4" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#9945FF" />
          <stop offset="48%" stopColor="#14F195" />
          <stop offset="100%" stopColor="#00D1FF" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="28" height="28" rx="14" fill="#07100f" />
      <path fill="url(#sol-a)" d="M8.15 8.2c.21-.21.5-.33.8-.33h17.16c.51 0 .77.62.41.98l-3.31 3.32c-.22.21-.51.33-.81.33H5.24c-.51 0-.77-.62-.41-.98L8.15 8.2z" />
      <path fill="url(#sol-a)" d="M23.21 14.35c-.22-.21-.51-.33-.81-.33H5.24c-.51 0-.77.62-.41.98l3.32 3.31c.21.22.5.34.8.34h17.16c.51 0 .77-.62.41-.98l-3.31-3.32z" />
      <path fill="url(#sol-a)" d="M8.15 20.5c.21-.21.5-.33.8-.33h17.16c.51 0 .77.62.41.98l-3.31 3.32c-.22.21-.51.33-.81.33H5.24c-.51 0-.77-.62-.41-.98l3.32-3.32z" />
    </svg>
  ),
};

function AssetLogo({ asset }: { asset: string }) {
  return ASSET_LOGOS[asset] ?? (
    <span style={{ width: 20, height: 20, display: "grid", placeItems: "center", fontWeight: 800, fontSize: 11 }}>
      {asset.slice(0, 1)}
    </span>
  );
}

type MarketSelectorProps = {
  activeAsset: Asset;
  assets: Asset[];
  markets: MarketSnapshot[];
  oraclePrices: Partial<Record<Asset, OraclePriceSnapshot>>;
  onSelect: (asset: Asset) => void;
};

function resolvePriceLabel(asset: Asset, markets: MarketSnapshot[], oraclePrices: Partial<Record<Asset, OraclePriceSnapshot>>) {
  const market = markets.find((item) => item.asset === asset);
  const price = market ? Number(market.markPrice) : oraclePrices[asset]?.price;
  return price !== undefined && Number.isFinite(price) && price > 0 ? `$${formatMoney(price, 1)}` : "Loading";
}

function resolveMarketRow(asset: Asset, markets: MarketSnapshot[], oraclePrices: Partial<Record<Asset, OraclePriceSnapshot>>) {
  const market = markets.find((item) => item.asset === asset);
  const mark = market ? Number(market.markPrice) : oraclePrices[asset]?.price;
  const oracle = oraclePrices[asset]?.price ?? (market ? Number(market.indexPrice) : undefined);
  return {
    asset,
    markLabel: mark !== undefined && Number.isFinite(mark) && mark > 0 ? formatMoney(mark, mark >= 100 ? 1 : 4) : "Loading",
    oracleLabel: oracle !== undefined && Number.isFinite(oracle) && oracle > 0 ? formatMoney(oracle, oracle >= 100 ? 1 : 4) : "Loading",
    fundingLabel: market ? `${(market.fundingRateBps / 100).toFixed(4)}%` : "0.0000%",
    openInterestLabel: market
      ? `$${formatMoney(Number(market.openInterestLong) + Number(market.openInterestShort), 0)}`
      : "$0"
  };
}

export function MarketSelector({ activeAsset, assets, markets, oraclePrices, onSelect }: MarketSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"strict" | "all">("strict");
  const rootRef = useRef<HTMLElement | null>(null);
  const activePriceLabel = resolvePriceLabel(activeAsset, markets, oraclePrices);
  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return assets
      .filter((asset) => {
        if (!normalizedQuery) {
          return true;
        }
        return `${asset}-USDC`.toLowerCase().includes(normalizedQuery);
      })
      .map((asset) => resolveMarketRow(asset, markets, oraclePrices));
  }, [assets, markets, oraclePrices, query]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <section className="market-selector" ref={rootRef}>
      <button
        className="market-selector__lead"
        type="button"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        onClick={() => setIsOpen((current) => !current)}
      >
        <div className="market-selector__icon" aria-hidden="true"><AssetLogo asset={activeAsset} /></div>
        <div>
          <strong>{activeAsset}-USDC</strong>
          <span>Perpetual</span>
        </div>
        <span className={`market-selector__chevron ${isOpen ? "is-open" : ""}`} aria-hidden="true" />
      </button>
      <div className="market-select-summary">
        <span>Mark</span>
        <strong aria-live="polite">{activePriceLabel}</strong>
      </div>

      {isOpen ? (
        <div className="market-menu" role="dialog" aria-label="Select market">
          <div className="market-menu__top">
            <label className="market-menu__search">
              <span className="sr-only">Search markets</span>
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search"
                type="search"
              />
            </label>
            <div className="market-menu__scope" role="group" aria-label="Market filter strictness">
              <button
                className={scope === "strict" ? "is-active" : ""}
                type="button"
                onClick={() => setScope("strict")}
              >
                Strict
              </button>
              <button
                className={scope === "all" ? "is-active" : ""}
                type="button"
                onClick={() => setScope("all")}
              >
                All
              </button>
            </div>
          </div>

          <div className="market-menu__tabs" aria-label="Market categories">
            {["All", "Perps", "Spot", "Outcome", "Crypto", "Trending", "Pre-launch"].map((tab) => (
              <button className={tab === "Perps" ? "is-active" : ""} key={tab} type="button">
                {tab}
              </button>
            ))}
          </div>

          <div className="market-menu__table">
            <div className="market-menu__head" role="row">
              <span>Symbol</span>
              <span>Last Price</span>
              <span>Oracle</span>
              <span>8h Funding</span>
              <span>Open Interest</span>
            </div>
            {filteredRows.length > 0 ? filteredRows.map((row) => (
              <button
                className={`market-menu__row ${row.asset === activeAsset ? "is-active" : ""}`}
                key={row.asset}
                type="button"
                onClick={() => {
                  onSelect(row.asset);
                  setIsOpen(false);
                }}
              >
                <span className="market-menu__symbol">
                  <AssetLogo asset={row.asset} />
                  <strong>{row.asset}-USDC</strong>
                  <em>10x</em>
                </span>
                <span>{row.markLabel}</span>
                <span>{row.oracleLabel}</span>
                <span>{row.fundingLabel}</span>
                <span>{row.openInterestLabel}</span>
              </button>
            )) : (
              <div className="market-menu__empty">No markets found.</div>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
