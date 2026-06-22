import { VarixLogo } from "./VarixLogo";
import type { TradeMode } from "../types";

type NavBarProps = {
  collateral: string;
  identity: string | null;
  isConnected: boolean;
  tradeMode: TradeMode;
  walletCtaLabel: string;
  walletCtaDisabled: boolean;
  walletCtaTitle?: string | null;
  onTradeModeChange: (mode: TradeMode) => void;
  onDisconnect: () => void;
  onFundGas?: (() => void) | null;
  onWalletCta: () => void;
  onScrollToAccount: () => void;
};

export function NavBar({
  collateral,
  identity,
  isConnected,
  tradeMode,
  walletCtaLabel,
  walletCtaDisabled,
  walletCtaTitle,
  onTradeModeChange,
  onDisconnect,
  onFundGas,
  onWalletCta,
  onScrollToAccount
}: NavBarProps) {
  return (
    <header className="nav">
      <div className="nav-brand">
        <VarixLogo />
      </div>
      <nav className="nav-links" aria-label="Primary">
        <button className="nav-link is-active" type="button">Trade</button>
        <button className="nav-link" type="button">Portfolio</button>
        <button className="nav-link" type="button">Earn</button>
        <button className="nav-link" type="button">Vaults</button>
        <button className="nav-link" type="button">Leaderboard</button>
      </nav>
      <div className="nav-actions">
        <div className="network-toggle" aria-label="Trade runtime">
          <button
            className={tradeMode === "vara" ? "is-active" : undefined}
            onClick={() => onTradeModeChange("vara")}
            type="button"
          >
            Vara
          </button>
          <button
            className={tradeMode === "vara-eth" ? "is-active" : undefined}
            onClick={() => onTradeModeChange("vara-eth")}
            type="button"
          >
            Vara.eth
          </button>
        </div>
        <button
          className="nav-wallet-cta"
          disabled={walletCtaDisabled}
          onClick={onWalletCta}
          title={walletCtaTitle ?? undefined}
          type="button"
        >
          {walletCtaLabel}
        </button>
        {isConnected ? (
          <details className="wallet-menu">
            <summary aria-label="Wallet actions">
              Wallet
              <span aria-hidden="true" />
            </summary>
            <div className="wallet-menu__content">
              {onFundGas ? (
                <button onClick={onFundGas} type="button">
                  Fund Gas
                </button>
              ) : null}
              <button onClick={onDisconnect} type="button">
                Disconnect Wallet
              </button>
            </div>
          </details>
        ) : null}
        <button className="deposit-chip" onClick={onScrollToAccount} type="button">
          Deposit
        </button>
        <div className="nav-account">
          <span>{tradeMode === "vara" ? "Vara Wallet" : "EVM Wallet"}</span>
          <strong>{identity ?? "Not connected"}</strong>
        </div>
        <div className="nav-collateral">
          <span>Collateral</span>
          <strong>{collateral} USDC</strong>
        </div>
      </div>
    </header>
  );
}
