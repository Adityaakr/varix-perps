import { useState } from "react";
import type { AccountSnapshot, SessionSnapshot } from "../types";

type AccountPanelProps = {
  account: AccountSnapshot | null;
  actionDisabled: boolean;
  identityLabel: string | null;
  actionReason: string | null;
  session: SessionSnapshot | null;
  onMint: (amount: number) => Promise<void>;
  onProvideLiquidity: (amount: number) => Promise<void>;
  onDeposit: (amount: number) => Promise<void>;
  onWithdraw: (amount: number) => Promise<void>;
};

export function AccountPanel({ account, actionDisabled, actionReason, identityLabel, session, onDeposit, onMint, onProvideLiquidity, onWithdraw }: AccountPanelProps) {
  const [amount, setAmount] = useState(1_000);
  const [busy, setBusy] = useState(false);

  async function handle(action: "mint" | "deposit" | "withdraw" | "liquidity") {
    setBusy(true);
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
      setBusy(false);
    }
  }

  return (
    <section className="account-panel terminal-panel">
      <div className="panel-header">
        <h2>Balances</h2>
        <span className="muted-text">{identityLabel ?? (session ? session.name : "No session")}</span>
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
          <em>{session ? "tUSDC" : "USDC"}</em>
        </div>
      </label>
      <div className="account-actions">
        <button className="secondary-button" disabled={busy || actionDisabled} onClick={() => void handle("mint")} type="button">
          Mint tUSDC
        </button>
        <button className="secondary-button" disabled={busy || actionDisabled} onClick={() => void handle("liquidity")} type="button">
          Fund LP
        </button>
        <button className="secondary-button" disabled={busy || actionDisabled} onClick={() => void handle("deposit")} type="button">
          Deposit
        </button>
        <button className="secondary-button" disabled={busy || actionDisabled} onClick={() => void handle("withdraw")} type="button">
          Withdraw
        </button>
      </div>
      <p className="panel-note">{actionReason ?? (session ? "Account actions are ready." : "Connect a wallet or start a session to move collateral.")}</p>
    </section>
  );
}
