import type { ReactNode } from "react";

type WalletPanelProps = {
  actionPending: boolean;
  accountLabel: string | null;
  connectLabel: string;
  details?: ReactNode;
  disabledReason: string | null;
  gaslessEnabled?: boolean;
  note?: string | null;
  panelTitle?: string;
  onClearSession?: (() => void) | null;
  onConnect: () => void;
  modeToggle?: {
    ariaLabel: string;
    current: string;
    disabled?: boolean;
    onChange: (value: string) => void;
    options: Array<{ label: string; value: string }>;
  } | null;
  onSetSignlessMode?: ((enabled: boolean) => void) | null;
  ready: boolean;
  runtimeLabel?: string;
  showSigningToggle?: boolean;
  statusLabel?: string;
  signlessAvailable?: boolean;
  sessionLabel?: string | null;
  signlessEnabled?: boolean;
  signlessModeEnabled?: boolean;
  signlessToggleDisabled?: boolean;
};

export function WalletPanel({
  actionPending,
  accountLabel,
  connectLabel,
  details,
  disabledReason,
  gaslessEnabled,
  note,
  panelTitle = "Vara Wallet",
  onClearSession,
  onConnect,
  modeToggle,
  onSetSignlessMode,
  ready,
  runtimeLabel = "On-chain",
  showSigningToggle = true,
  statusLabel = "Session",
  signlessAvailable,
  sessionLabel,
  signlessEnabled,
  signlessModeEnabled,
  signlessToggleDisabled
}: WalletPanelProps) {
  const resolvedNote = note
    ?? disabledReason
    ?? (signlessModeEnabled
      ? "Signless mode is active. Session actions use the local session signer."
      : signlessAvailable && signlessEnabled
        ? "Session voucher is available, but signless mode is off. Actions will use the wallet signer."
        : signlessAvailable
          ? "Session signer is ready. Switch signless on to avoid wallet popups for session actions."
        : gaslessEnabled
          ? "Gasless sponsorship is ready. Switch signless on after registering a session."
          : "Wallet-signed mode is active. Actions will use the connected wallet."
    );

  return (
    <section className="wallet-panel terminal-panel">
      <div className="panel-header">
        <h2>{panelTitle}</h2>
        <span className={`status-pill ${ready ? "is-live" : ""}`}>{ready ? "Ready" : "Waiting"}</span>
      </div>
      <dl className="wallet-grid">
        <div>
          <dt>Runtime</dt>
          <dd>{runtimeLabel}</dd>
        </div>
        <div>
          <dt>Identity</dt>
          <dd>{accountLabel ?? "Not connected"}</dd>
        </div>
        <div>
          <dt>{statusLabel}</dt>
          <dd>{sessionLabel ?? "Not active"}</dd>
        </div>
      </dl>
      {showSigningToggle ? (
        <div className="runtime-toggle" aria-label="Signing mode">
          <button
            className={!signlessModeEnabled ? "is-active" : undefined}
            disabled={signlessToggleDisabled}
            onClick={() => onSetSignlessMode?.(false)}
            type="button"
          >
            Signed
          </button>
          <button
            className={signlessModeEnabled ? "is-active" : undefined}
            disabled={signlessToggleDisabled || !signlessAvailable}
            onClick={() => onSetSignlessMode?.(true)}
            type="button"
          >
            Signless
          </button>
        </div>
      ) : null}
      {modeToggle ? (
        <div className="runtime-toggle" aria-label={modeToggle.ariaLabel}>
          {modeToggle.options.map((option) => (
            <button
              className={modeToggle.current === option.value ? "is-active" : undefined}
              disabled={modeToggle.disabled}
              key={option.value}
              onClick={() => modeToggle.onChange(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
      <button className="secondary-button wallet-action" disabled={!ready || actionPending} onClick={onConnect} type="button">
        {actionPending ? "Transaction Pending" : connectLabel}
      </button>
      {onClearSession ? (
        <button className="secondary-button wide-secondary" onClick={onClearSession} type="button">
          Revoke Session
        </button>
      ) : null}
      <p className="panel-note">{resolvedNote}</p>
      {details ? <div className="wallet-details">{details}</div> : null}
    </section>
  );
}
