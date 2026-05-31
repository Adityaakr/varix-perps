import { useMemo, useState } from "react";
import type { AccountSnapshot } from "../types";

type AccountPanelProps = {
  account: AccountSnapshot | null;
  actionDisabled: boolean;
  actionLabels?: {
    deposit: string;
    liquidity: string;
    mint: string;
    withdraw: string;
  };
  identityLabel: string | null;
  actionReason: string | null;
  note?: string | null;
  sessionLabel: string | null;
  showActionControls?: boolean;
  onMint: (amount: number) => Promise<void>;
  onProvideLiquidity: (amount: number) => Promise<void>;
  onDeposit: (amount: number) => Promise<void>;
  onWithdraw: (amount: number) => Promise<void>;
};

export function AccountPanel({
  account,
  actionDisabled,
  actionLabels,
  actionReason,
  identityLabel,
  note: noteOverride,
  sessionLabel,
  showActionControls = true,
  onDeposit,
  onMint,
  onProvideLiquidity,
  onWithdraw
}: AccountPanelProps) {
  const [amount, setAmount] = useState(1_000);
  const [busyAction, setBusyAction] = useState<"mint" | "deposit" | "withdraw" | "liquidity" | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const note = useMemo(() => {
    if (validationError) {
      return validationError;
    }
    if (noteOverride) {
      return noteOverride;
    }
    if (actionReason) {
      return actionReason;
    }
    return sessionLabel
      ? "Session signer is ready. Mint, move collateral, or fund LP on-chain."
      : "Register a session first, then mint demo collateral and continue the local happy path.";
  }, [actionReason, noteOverride, sessionLabel, validationError]);

  const labels = actionLabels ?? {
    mint: "Mint tUSDC",
    liquidity: "Fund LP",
    deposit: "Deposit",
    withdraw: "Withdraw"
  };

  async function handle(action: "mint" | "deposit" | "withdraw" | "liquidity") {
    if (!Number.isFinite(amount) || amount < 100) {
      setValidationError("Enter an amount of at least 100 before sending an on-chain action.");
      return;
    }

    setValidationError(null);
    setBusyAction(action);
    try {
      if (action === "mint") {
        await onMint(amount);
      } else if (action === "deposit") {
        await onDeposit(amount);
      } else if (action === "liquidity") {
        await onProvideLiquidity(amount);
      } else {
        await onWithdraw(amount);
      }
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <section className="account-panel terminal-panel" id="varix-account">
      <div className="panel-header">
        <h2>Balances</h2>
        <span className="muted-text">{sessionLabel ?? identityLabel ?? "No active session"}</span>
      </div>
      <dl className="balance-grid">
        <div>
          <dt>Equity</dt>
          <dd>{account ? `${account.equity} USDC` : "-"}</dd>
        </div>
        <div>
          <dt>Wallet</dt>
          <dd>{account ? `${account.walletBalance} tUSDC` : "-"}</dd>
        </div>
        <div>
          <dt>Free</dt>
          <dd>{account ? `${account.freeCollateral} USDC` : "-"}</dd>
        </div>
        <div>
          <dt>Locked</dt>
          <dd>{account ? `${account.lockedCollateral} USDC` : "-"}</dd>
        </div>
        <div>
          <dt>LP Shares</dt>
          <dd>{account ? `${account.lpShares} tUSDC` : "-"}</dd>
        </div>
      </dl>
      {showActionControls ? (
        <>
          <label className="field">
            <span>Amount</span>
            <div className="field-shell">
              <input min={100} onChange={(event) => setAmount(Number(event.target.value))} type="number" value={amount} />
              <em>tUSDC</em>
            </div>
          </label>
          <div className="account-actions">
            <button className="secondary-button" disabled={busyAction !== null || actionDisabled} onClick={() => void handle("mint")} type="button">
              {busyAction === "mint" ? "Minting..." : labels.mint}
            </button>
            <button className="secondary-button" disabled={busyAction !== null || actionDisabled} onClick={() => void handle("liquidity")} type="button">
              {busyAction === "liquidity" ? "Funding..." : labels.liquidity}
            </button>
            <button className="secondary-button" disabled={busyAction !== null || actionDisabled} onClick={() => void handle("deposit")} type="button">
              {busyAction === "deposit" ? "Depositing..." : labels.deposit}
            </button>
            <button className="secondary-button" disabled={busyAction !== null || actionDisabled} onClick={() => void handle("withdraw")} type="button">
              {busyAction === "withdraw" ? "Withdrawing..." : labels.withdraw}
            </button>
          </div>
        </>
      ) : null}
      <p className={`panel-note${validationError ? " is-error" : ""}`}>{note}</p>
    </section>
  );
}
