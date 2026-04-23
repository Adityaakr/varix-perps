type WalletPanelProps = {
  accountLabel: string | null;
  connectLabel: string;
  disabledReason: string | null;
  onClearSession?: (() => void) | null;
  onConnect: () => void;
  onDisconnect?: (() => void) | null;
  onFundGas?: (() => void) | null;
  ready: boolean;
  sessionLabel?: string | null;
};

export function WalletPanel({
  accountLabel,
  connectLabel,
  disabledReason,
  onClearSession,
  onConnect,
  onDisconnect,
  onFundGas,
  ready,
  sessionLabel
}: WalletPanelProps) {
  return (
    <section className="wallet-panel terminal-panel">
      <div className="panel-header">
        <h2>Vara Wallet</h2>
        <span className={`status-pill ${ready ? "is-live" : ""}`}>{ready ? "Ready" : "Waiting"}</span>
      </div>
      <dl className="wallet-grid">
        <div>
          <dt>Runtime</dt>
          <dd>On-chain</dd>
        </div>
        <div>
          <dt>Identity</dt>
          <dd>{accountLabel ?? "Not connected"}</dd>
        </div>
        <div>
          <dt>Session</dt>
          <dd>{sessionLabel ?? "Not registered"}</dd>
        </div>
      </dl>
      <button className="secondary-button wallet-action" disabled={!ready} onClick={onConnect} type="button">
        {connectLabel}
      </button>
      {onDisconnect ? (
        <button className="secondary-button wide-secondary" onClick={onDisconnect} type="button">
          Disconnect Wallet
        </button>
      ) : null}
      {onFundGas ? (
        <button className="secondary-button wide-secondary" onClick={onFundGas} type="button">
          Fund Gas
        </button>
      ) : null}
      {onClearSession ? (
        <button className="secondary-button wide-secondary" onClick={onClearSession} type="button">
          Revoke Session
        </button>
      ) : null}
      <p className="panel-note">{disabledReason ?? "Wallet is ready for signed transactions."}</p>
    </section>
  );
}
