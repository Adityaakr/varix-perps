type NavBarProps = {
  collateral: string;
  identity: string | null;
  isConnected: boolean;
  walletCtaLabel: string;
  walletCtaDisabled: boolean;
  walletCtaTitle?: string | null;
  onDisconnect: () => void;
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
  onWalletCta,
  onScrollToAccount
}: NavBarProps) {
  return (
    <header className="nav">
      <div className="nav-brand">
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
        </div>
        <div className="brand-copy">
          <strong>Varix</strong>
          <span className="brand-subtitle">Perps on Vara</span>
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
          <button className="nav-disconnect" onClick={onDisconnect} type="button">
            Disconnect
          </button>
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
