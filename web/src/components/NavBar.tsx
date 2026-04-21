type NavBarProps = {
  collateral: string;
  identity: string | null;
  mode: "demo" | "vara";
  onModeChange: (mode: "demo" | "vara") => void;
};

export function NavBar({ collateral, identity, mode, onModeChange }: NavBarProps) {
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
        <button className="deposit-chip" type="button">
          Deposit
        </button>
        <div className="nav-account">
          <span>{mode === "vara" ? "Wallet" : "Session"}</span>
          <strong>{identity ?? (mode === "vara" ? "Not connected" : "Not started")}</strong>
        </div>
        <div className="nav-collateral">
          <span>Collateral</span>
          <strong>{collateral} USDC</strong>
        </div>
        <div className="runtime-toggle">
          <button className={mode === "vara" ? "is-active" : ""} onClick={() => onModeChange("vara")} type="button">
            Vara
          </button>
          <button className={mode === "demo" ? "is-active" : ""} onClick={() => onModeChange("demo")} type="button">
            Demo
          </button>
        </div>
      </div>
    </header>
  );
}
