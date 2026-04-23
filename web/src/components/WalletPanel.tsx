type WalletPanelProps = {
  actionPending: boolean;
  accountLabel: string | null;
  connectLabel: string;
  disabledReason: string | null;
  onClearSession?: (() => void) | null;
  onConnect: () => void;
  ready: boolean;
  sessionLabel?: string | null;
};

export function WalletPanel({
  actionPending,
  accountLabel,
  connectLabel,
  disabledReason,
  onClearSession,
  onConnect,
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
      <button className="secondary-button wallet-action" disabled={!ready || actionPending} onClick={onConnect} type="button">
        {actionPending ? "Transaction Pending" : connectLabel}
      </button>
      {onClearSession ? (
        <button className="secondary-button wide-secondary" onClick={onClearSession} type="button">
          Revoke Session
        </button>
      ) : null}
      <p className="panel-note">{disabledReason ?? "Wallet is ready for signed transactions."}</p>
    </section>
  );
}
