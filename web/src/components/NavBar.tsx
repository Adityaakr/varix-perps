import { VarixLogo } from "./VarixLogo";

type NavBarProps = {
  collateral: string;
  identity: string | null;
  isConnected: boolean;
  walletCtaLabel: string;
  walletCtaDisabled: boolean;
  walletCtaTitle?: string | null;
  onDisconnect: () => void;
  onFundGas?: (() => void) | null;
  onWalletCta: () => void;
  onScrollToAccount: () => void;
};

export function NavBar({
  collateral,
  identity,
  isConnected,
  walletCtaLabel,
  walletCtaDisabled,
  walletCtaTitle,
  onDisconnect,
  onFundGas,
  onWalletCta,
  onScrollToAccount
}: NavBarProps) {
  return (
    <header className="nav">
      <div className="nav-brand">
        <VarixLogo />
        <div className="brand-copy">
          <span className="brand-subtitle">Perpetual DEX</span>
          <strong>Trade global markets on Vara</strong>
        </div>
      </div>
      <nav className="nav-links" aria-label="Primary">
        <button className="nav-link is-active" type="button">Trade</button>
        <button className="nav-link" type="button">Portfolio</button>
        <button className="nav-link" type="button">Earn</button>
        <button className="nav-link" type="button">Vaults</button>
        <button className="nav-link" type="button">Leaderboard</button>
      </nav>
      <div className="nav-actions">
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
          <span>Wallet</span>
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
