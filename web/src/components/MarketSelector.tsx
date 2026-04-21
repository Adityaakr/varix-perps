import type { Asset, MarketSnapshot } from "../types";
import { formatMoney } from "../lib/format";

type MarketSelectorProps = {
  activeAsset: Asset;
  markets: MarketSnapshot[];
  onSelect: (asset: Asset) => void;
};

const assets: Asset[] = ["BTC", "ETH", "SOL"];

export function MarketSelector({ activeAsset, markets, onSelect }: MarketSelectorProps) {
  return (
    <section className="market-selector">
      <div className="market-selector__lead">
        <div className="market-selector__icon" aria-hidden="true">{activeAsset.slice(0, 1)}</div>
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
