import { useMemo, useState } from "react";
import { AccountPanel } from "./components/AccountPanel";
import { Chart } from "./components/Chart";
import { MarketSelector } from "./components/MarketSelector";
import { NavBar } from "./components/NavBar";
import { OrderBook } from "./components/OrderBook";
import { OrderForm } from "./components/OrderForm";
import { PositionsTable } from "./components/PositionsTable";
import { WalletPanel } from "./components/WalletPanel";
import { useCandles } from "./hooks/useCandles";
import { useMarketState } from "./hooks/useMarketState";
import { useOrderBook } from "./hooks/useOrderBook";
import { useTraderSession } from "./hooks/useTraderSession";
import { useWalletStatus } from "./hooks/useWalletStatus";
import { useVaraProgram } from "./hooks/useVaraProgram";
import { getDefaultRuntimeMode, hasVaraPrograms } from "./lib/config";
import { formatMoney } from "./lib/format";
import type { Asset, RuntimeMode } from "./types";

export default function App() {
  const [asset, setAsset] = useState<Asset>("BTC");
  const [chartInterval, setChartInterval] = useState<"5m" | "1h" | "1d">("1h");
  const [mode, setMode] = useState<RuntimeMode>(getDefaultRuntimeMode());
  const { sessionToken, persistSession } = useTraderSession();
  const wallet = useWalletStatus();
  const demoSnapshot = useMarketState(asset, mode === "demo" ? sessionToken : null);
  const candles = useCandles(asset, chartInterval);
  const orderBook = useOrderBook(asset);
  const varaProgram = useVaraProgram(asset, mode, sessionToken);

  const market = mode === "vara" ? varaProgram.onchainMarket ?? demoSnapshot.market : demoSnapshot.market;
  const positions = useMemo(
    () => (mode === "vara" ? (varaProgram.onchainPosition ? [varaProgram.onchainPosition] : []) : demoSnapshot.positions),
    [demoSnapshot.positions, mode, varaProgram.onchainPosition]
  );
  const snapshot = useMemo(
    () => ({
      ...demoSnapshot.snapshot,
      account: mode === "vara" ? varaProgram.onchainAccount : demoSnapshot.snapshot.account,
      session:
        mode === "vara"
          ? null
          : demoSnapshot.snapshot.session
    }),
    [demoSnapshot.snapshot, mode, varaProgram.onchainAccount]
  );
  const identity = mode === "vara" ? wallet.accountLabel : snapshot.session?.name ?? null;
  const varaSessionLabel = varaProgram.onchainSession
    ? `${varaProgram.hasSessionSigner ? "Signer ready" : "Wallet only"} • ${varaProgram.onchainSession.sessionKey.slice(0, 6)}…${varaProgram.onchainSession.sessionKey.slice(-4)} • exp ${varaProgram.onchainSession.expiresAt}`
    : null;
  const topMarketStats = [
    { label: "Mark", value: market ? `${formatMoney(market.markPrice, 1)}` : "-" },
    { label: "Oracle", value: market ? `${formatMoney(market.indexPrice, 1)}` : "-" },
    {
      label: "Funding",
      value: market ? `${(market.fundingRateBps / 100).toFixed(2)} bps` : "-"
    },
    { label: "OI Long", value: market ? formatMoney(market.openInterestLong, 0) : "-" },
    { label: "OI Short", value: market ? formatMoney(market.openInterestShort, 0) : "-" },
    { label: "LP Liquidity", value: snapshot.liquidityPool.totalLiquidity },
    { label: "Max OI", value: snapshot.liquidityPool.maxOpenNotional },
    { label: "Insurance", value: snapshot.insuranceFund }
  ];

  function handleModeChange(nextMode: RuntimeMode) {
    if (nextMode === "vara" && !hasVaraPrograms()) {
      return;
    }

    setMode(nextMode);
  }

  return (
    <div className="app-shell">
      <NavBar
        collateral={formatMoney(snapshot.account?.freeCollateral ?? 0)}
        identity={identity}
        mode={mode}
        onModeChange={handleModeChange}
      />

      <main className="terminal-shell has-bottom-row">
        <section className="market-ribbon terminal-panel">
          <MarketSelector activeAsset={asset} markets={demoSnapshot.snapshot.markets} onSelect={setAsset} />
          <div className="market-stats-grid">
            {topMarketStats.map((item) => (
              <div className="market-stat" key={item.label}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
        </section>

        <section className="terminal-layout">
          <div className="chart-column">
            <Chart asset={asset} candles={candles} intervalLabel={chartInterval} onIntervalChange={setChartInterval} />
          </div>

          <div className="book-column">
            <OrderBook asks={orderBook.asks} bids={orderBook.bids} updatedAt={orderBook.updatedAt} />
          </div>

          <aside className="trade-column">
            <WalletPanel
              accountLabel={identity}
              connectLabel={
                mode === "vara"
                  ? wallet.isConnected
                    ? varaProgram.onchainSession
                      ? "Refresh Session"
                      : "Register Session"
                    : wallet.connectLabel
                  : snapshot.session
                    ? "New Session"
                    : "Start Session"
              }
              disabledReason={
                mode === "vara"
                  ? !hasVaraPrograms()
                    ? "Set VITE_SESSION_REGISTRY_PROGRAM_ID, VITE_MARGIN_VAULT_PROGRAM_ID, VITE_ORACLE_SERVICE_PROGRAM_ID, and VITE_*_MARKET_PROGRAM_ID env vars."
                    : wallet.disabledReason
                  : null
              }
              mode={mode}
              onClearSession={
                mode === "vara" && varaProgram.onchainSession
                  ? () => {
                      void varaProgram.revokeSession();
                    }
                  : null
              }
              onConnect={() => {
                if (mode === "vara") {
                  if (!wallet.isConnected) {
                    void wallet.connect();
                    return;
                  }

                  void varaProgram.createSession();
                  return;
                }

                void varaProgram.createSession().then((result) => {
                  if (result) {
                    demoSnapshot.applySnapshot(result.snapshot);
                    persistSession(result.session);
                  }
                });
              }}
              ready={mode === "vara" ? (wallet.isConnected ? true : wallet.isReady) : true}
              sessionLabel={mode === "vara" ? varaSessionLabel : null}
            />
            <OrderForm
              disabledReason={
                mode === "vara"
                  ? !hasVaraPrograms()
                    ? "Set deployed market and vault program IDs to trade on Vara."
                    : wallet.disabledReason
                  : snapshot.session
                    ? null
                    : "Start a demo session before placing orders."
              }
              market={market}
              onSubmit={async (input) => {
                await varaProgram.openPosition(input);
              }}
            />
            <AccountPanel
              account={snapshot.account}
              actionDisabled={mode === "vara" ? !varaProgram.isVaraReady : !snapshot.session}
              identityLabel={identity}
              actionReason={
                mode === "vara"
                  ? !hasVaraPrograms()
                    ? "Program IDs are missing, so on-chain margin actions are disabled."
                    : wallet.disabledReason
                  : snapshot.session
                    ? null
                    : "Start a demo session before moving collateral."
              }
              onDeposit={async (amount) => {
                await varaProgram.deposit(amount);
              }}
              onMint={async (amount) => {
                await varaProgram.mintDemoTokens(amount);
              }}
              onProvideLiquidity={async (amount) => {
                await varaProgram.provideDemoLiquidity(amount);
              }}
              onWithdraw={async (amount) => {
                await varaProgram.withdraw(amount);
              }}
              session={snapshot.session}
            />
          </aside>
        </section>

        <section className="bottom-row">
          <PositionsTable
            onClose={async (closeAsset) => {
              await varaProgram.closePosition(closeAsset);
            }}
            positions={positions}
          />
        </section>
      </main>
    </div>
  );
}
