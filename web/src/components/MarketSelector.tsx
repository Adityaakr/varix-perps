import type { ReactNode } from "react";
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
      <g fill="none" fillRule="evenodd">
        <circle cx="16" cy="16" r="16" fill="#000" />
        <g transform="translate(6 8)">
          <linearGradient id="sol-a" x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#9945FF" />
            <stop offset="50%" stopColor="#14F195" />
            <stop offset="100%" stopColor="#00D1FF" />
          </linearGradient>
          <path fill="url(#sol-a)" d="M3.5 11.4l2.8-2.8c.2-.2.4-.3.7-.3h12.7c.4 0 .6.5.3.8l-2.8 2.8c-.2.2-.4.3-.7.3H3.8c-.4 0-.6-.5-.3-.8zm2.8-8.1c.2-.2.4-.3.7-.3h12.7c.4 0 .6.5.3.8L17.2 6.6c-.2.2-.4.3-.7.3H3.8c-.4 0-.6-.5-.3-.8l2.8-2.8zm10.5 5.4c-.2-.2-.4-.3-.7-.3H3.4c-.4 0-.6.5-.3.8l2.8 2.8c.2.2.4.3.7.3h12.7c.4 0 .6-.5.3-.8l-2.8-2.8z" />
        </g>
      </g>
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
  onSelect: (asset: Asset) => void;
};

export function MarketSelector({ activeAsset, assets, markets, onSelect }: MarketSelectorProps) {
  return (
    <section className="market-selector">
      <div className="market-selector__lead">
        <div className="market-selector__icon" aria-hidden="true"><AssetLogo asset={activeAsset} /></div>
        <div>
          <strong>{activeAsset}-USDC</strong>
          <span>Perpetual</span>
        </div>
      </div>
      <div className="market-list">
        {assets.map((asset) => {
          const market = markets.find((item) => item.asset === asset);
          return (
            <button
              key={asset}
              className={`market-pill ${activeAsset === asset ? "is-active" : ""}`}
              onClick={() => onSelect(asset)}
              type="button"
            >
              <span>{asset}</span>
              <strong>{market ? `$${formatMoney(market.markPrice, 1)}` : "Waiting..."}</strong>
            </button>
          );
        })}
      </div>
    </section>
  );
}
