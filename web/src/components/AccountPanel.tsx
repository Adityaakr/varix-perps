import { useMemo, useState } from "react";
import type { AccountSnapshot } from "../types";

type AccountPanelProps = {
  account: AccountSnapshot | null;
  actionDisabled: boolean;
  identityLabel: string | null;
  actionReason: string | null;
  sessionLabel: string | null;
  onMint: (amount: number) => Promise<void>;
  onProvideLiquidity: (amount: number) => Promise<void>;
  onDeposit: (amount: number) => Promise<void>;
  onWithdraw: (amount: number) => Promise<void>;
};

export function AccountPanel({ account, actionDisabled, actionReason, identityLabel, sessionLabel, onDeposit, onMint, onProvideLiquidity, onWithdraw }: AccountPanelProps) {
  const [amount, setAmount] = useState(1_000);
  const [busyAction, setBusyAction] = useState<"mint" | "deposit" | "withdraw" | "liquidity" | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const note = useMemo(() => {
    if (validationError) {
      return validationError;
    }
    if (actionReason) {
      return actionReason;
    }
    return sessionLabel
      ? "Session signer is ready. Mint, move collateral, or fund LP on-chain."
      : "Register a session first, then mint demo collateral and continue the local happy path.";
  }, [actionReason, sessionLabel, validationError]);

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
      <label className="field">
        <span>Amount</span>
        <div className="field-shell">
          <input min={100} onChange={(event) => setAmount(Number(event.target.value))} type="number" value={amount} />
          <em>tUSDC</em>
        </div>
      </label>
      <div className="account-actions">
        <button className="secondary-button" disabled={busyAction !== null || actionDisabled} onClick={() => void handle("mint")} type="button">
          {busyAction === "mint" ? "Minting..." : "Mint tUSDC"}
        </button>
        <button className="secondary-button" disabled={busyAction !== null || actionDisabled} onClick={() => void handle("liquidity")} type="button">
          {busyAction === "liquidity" ? "Funding..." : "Fund LP"}
        </button>
        <button className="secondary-button" disabled={busyAction !== null || actionDisabled} onClick={() => void handle("deposit")} type="button">
          {busyAction === "deposit" ? "Depositing..." : "Deposit"}
        </button>
        <button className="secondary-button" disabled={busyAction !== null || actionDisabled} onClick={() => void handle("withdraw")} type="button">
          {busyAction === "withdraw" ? "Withdrawing..." : "Withdraw"}
        </button>
      </div>
      <p className={`panel-note${validationError ? " is-error" : ""}`}>{note}</p>
    </section>
  );
}
