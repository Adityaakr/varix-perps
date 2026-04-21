type WalletPanelProps = {
  accountLabel: string | null;
  connectLabel: string;
  disabledReason: string | null;
  mode: "demo" | "vara";
  onClearSession?: (() => void) | null;
  onConnect: () => void;
  ready: boolean;
  sessionLabel?: string | null;
};

export function WalletPanel({ accountLabel, connectLabel, disabledReason, mode, onClearSession, onConnect, ready, sessionLabel }: WalletPanelProps) {
  return (
    <section className="wallet-panel terminal-panel">
      <div className="panel-header">
        <h2>{mode === "vara" ? "Vara Wallet" : "Demo Session"}</h2>
        <span className={`status-pill ${ready ? "is-live" : ""}`}>{ready ? "Ready" : "Waiting"}</span>
      </div>
      <dl className="wallet-grid">
        <div>
          <dt>Runtime</dt>
          <dd>{mode === "vara" ? "On-chain" : "Local demo"}</dd>
        </div>
        <div>
          <dt>Identity</dt>
          <dd>{accountLabel ?? (mode === "vara" ? "Not connected" : "No session")}</dd>
        </div>
        {mode === "vara" ? (
          <div>
            <dt>Session</dt>
            <dd>{sessionLabel ?? "Not registered"}</dd>
          </div>
        ) : null}
      </dl>
      <button className="secondary-button wallet-action" disabled={!ready} onClick={onConnect} type="button">
        {connectLabel}
      </button>
      {onClearSession ? (
        <button className="secondary-button wide-secondary" onClick={onClearSession} type="button">
          Revoke Session
        </button>
      ) : null}
      <p className="panel-note">{disabledReason ?? (mode === "vara" ? "Wallet is ready for signed transactions." : "Demo mode keeps a local trading session.")}</p>
    </section>
  );
}
