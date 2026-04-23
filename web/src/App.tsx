import { useEffect, useMemo, useState } from "react";
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
import { useRecentTrades } from "./hooks/useRecentTrades";
import { useWalletStatus } from "./hooks/useWalletStatus";
import { useVaraProgram } from "./hooks/useVaraProgram";
import { VARA_RPC_URL, getAvailableVaraAssets, getMissingVaraProgramEnvKeys } from "./lib/config";
import { formatMoney } from "./lib/format";
import type { Asset } from "./types";

export default function App() {
  const [asset, setAsset] = useState<Asset>("BTC");
  const [chartInterval, setChartInterval] = useState<"5m" | "1h" | "1d">("1h");
  const wallet = useWalletStatus();
  const availableAssets = useMemo(() => getAvailableVaraAssets(), []);
  const marketDataSnapshot = useMarketState(asset, null);
  const candles = useCandles(asset, chartInterval);
  const orderBook = useOrderBook(asset);
  const recentTrades = useRecentTrades(asset);
  const livePrice = useMemo(() => {
    const topBid = orderBook.bids[0]?.price;
    const topAsk = orderBook.asks[0]?.price;
    if (topBid && topAsk) {
      return (topBid + topAsk) / 2;
    }
    const latestTrade = recentTrades[0]?.price;
    if (latestTrade) {
      return latestTrade;
    }
    const lastCandle = candles.at(-1);
    if (lastCandle) {
      return lastCandle.c;
    }
    return null;
  }, [candles, orderBook.asks, orderBook.bids, recentTrades]);
  const varaProgram = useVaraProgram(asset, "vara", null, livePrice);
  const market = varaProgram.onchainMarket ?? marketDataSnapshot.market;
  const displayMarket = useMemo(() => {
    if (!market) {
      return livePrice === null
        ? null
        : {
            asset,
            markPrice: String(livePrice),
            indexPrice: String(livePrice),
            fundingRateBps: 0,
            cumulativeFundingRateBps: 0,
            openInterestLong: "0",
            openInterestShort: "0",
            updatedAt: Date.now()
          };
    }

    if (livePrice === null) {
      return market;
    }

    return {
      ...market,
      markPrice: String(livePrice),
      indexPrice: String(livePrice),
      updatedAt: Date.now()
    };
  }, [asset, livePrice, market]);
  const selectorMarkets = useMemo(() => {
    const map = new Map(marketDataSnapshot.snapshot.markets.map((item) => [item.asset, item]));
    if (displayMarket) {
      map.set(displayMarket.asset, displayMarket);
    }
    return Array.from(map.values());
  }, [displayMarket, marketDataSnapshot.snapshot.markets]);
  const positions = useMemo(
    () => (varaProgram.onchainPosition ? [varaProgram.onchainPosition] : []),
    [varaProgram.onchainPosition]
  );
  const snapshot = useMemo(
    () => ({
      ...marketDataSnapshot.snapshot,
      account: varaProgram.onchainAccount,
      liquidityPool: varaProgram.onchainPool
        ? {
            totalLiquidity: varaProgram.onchainPool.totalLiquidity,
            maxOpenNotional: varaProgram.onchainPool.maxOpenNotional,
            reservedNotional: varaProgram.onchainPool.reservedNotional
          }
        : marketDataSnapshot.snapshot.liquidityPool,
      session: null
    }),
    [marketDataSnapshot.snapshot, varaProgram.onchainAccount, varaProgram.onchainPool]
  );

  const identity = wallet.accountLabel;
  const missingProgramEnvKeys = getMissingVaraProgramEnvKeys();
  const programsOk = missingProgramEnvKeys.length === 0;
  const sessionReady = Boolean(varaProgram.onchainSession);

  const rpcReason =
    programsOk && !varaProgram.isApiReady
      ? `Cannot reach Vara RPC at ${VARA_RPC_URL}. Start the local dev node.`
      : null;
  const sessionReason =
    wallet.isConnected && varaProgram.isApiReady && !sessionReady
      ? "Register a session key first."
      : null;
  const sharedDisabledReason = !programsOk
    ? `Missing Vara env: ${missingProgramEnvKeys.join(", ")}.`
    : (rpcReason ?? wallet.disabledReason);
  const actionDisabledReason = sharedDisabledReason ?? sessionReason;
  const freeCollateral = Number(snapshot.account?.freeCollateral ?? 0);
  const maxOpenNotional = Number(snapshot.liquidityPool.maxOpenNotional ?? 0);
  const reservedNotional = Number(snapshot.liquidityPool.reservedNotional ?? 0);
  const availableNotional = Math.max(0, maxOpenNotional - reservedNotional);
  const tradeDisabledReason = actionDisabledReason
    ?? (sessionReady && freeCollateral <= 0
      ? "Deposit collateral before trading."
      : sessionReady && availableNotional <= 0
        ? "Fund LP before trading. The pool has no available capacity yet."
        : null);

  const navWalletLabel = wallet.isConnected
    ? varaProgram.onchainSession
      ? "Refresh Session"
      : "Register Session"
    : wallet.connectLabel;
  const navWalletDisabled =
    !programsOk ||
    varaProgram.actionPending ||
    (!wallet.isConnected && !wallet.isReady) ||
    (wallet.isConnected && !varaProgram.isApiReady);
  const navWalletTitle = sharedDisabledReason;

  const varaSessionLabel = varaProgram.onchainSession
    ? `${varaProgram.hasSessionSigner ? "Signer ready" : "Wallet only"} · ${varaProgram.onchainSession.sessionKey.slice(0, 6)}…${varaProgram.onchainSession.sessionKey.slice(-4)}`
    : null;

  const topMarketStats = [
    { label: "Mark", value: displayMarket ? formatMoney(displayMarket.markPrice, 1) : "-" },
    { label: "Oracle", value: displayMarket ? formatMoney(displayMarket.indexPrice, 1) : "-" },
    { label: "Funding", value: displayMarket ? `${(displayMarket.fundingRateBps / 100).toFixed(2)} bps` : "-" },
    { label: "OI Long", value: displayMarket ? formatMoney(displayMarket.openInterestLong, 0) : "-" },
    { label: "OI Short", value: displayMarket ? formatMoney(displayMarket.openInterestShort, 0) : "-" },
    { label: "LP", value: formatMoney(snapshot.liquidityPool.totalLiquidity, 0) },
    { label: "Reserved", value: formatMoney(snapshot.liquidityPool.reservedNotional, 0) },
    { label: "Max OI", value: formatMoney(snapshot.liquidityPool.maxOpenNotional, 0) }
  ];

  useEffect(() => {
    const nextAsset = availableAssets[0];
    if (nextAsset && !availableAssets.includes(asset)) {
      setAsset(nextAsset);
    }
  }, [asset, availableAssets]);

  return (
    <div className="app-shell">
      <NavBar
        collateral={formatMoney(snapshot.account?.freeCollateral ?? 0)}
        identity={identity}
        isConnected={wallet.isConnected}
        walletCtaDisabled={navWalletDisabled}
        walletCtaLabel={navWalletLabel}
        walletCtaTitle={navWalletTitle}
        onDisconnect={wallet.disconnect}
        onFundGas={
          wallet.isConnected
            ? () => {
                void varaProgram.fundWalletGas().catch(() => undefined);
              }
            : null
        }
        onScrollToAccount={() => {
          document
            .getElementById("varix-account")
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
        onWalletCta={() => {
          if (!wallet.isConnected) {
            void wallet.connect().catch(() => undefined);
            return;
          }
          void varaProgram.createSession().catch(() => undefined);
        }}
      />

      {(!programsOk || rpcReason) && (
        <div className="status-banner">
          {!programsOk
            ? `Missing: ${missingProgramEnvKeys.join(", ")}. Set in web/.env.local.`
            : rpcReason}
        </div>
      )}

      <div className="market-ribbon">
        <MarketSelector
          activeAsset={asset}
          assets={availableAssets.length > 0 ? availableAssets : ["BTC", "ETH", "SOL"]}
          markets={selectorMarkets}
          onSelect={setAsset}
        />
        <div className="market-stats-grid">
          {topMarketStats.map((item) => (
            <div className="market-stat" key={item.label}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
      </div>

      <div className="terminal-layout">
        <div className="chart-column">
          <Chart
            asset={asset}
            candles={candles}
            intervalLabel={chartInterval}
            onIntervalChange={setChartInterval}
          />
        </div>

        <div className="book-column">
          <OrderBook
            asks={orderBook.asks}
            bids={orderBook.bids}
            trades={recentTrades}
            updatedAt={orderBook.updatedAt}
          />
        </div>

        <aside className="trade-column">
          <WalletPanel
            accountLabel={identity}
            connectLabel={
              wallet.isConnected
                ? varaProgram.onchainSession
                  ? "Refresh Session"
                  : "Register Session"
                : wallet.connectLabel
            }
            disabledReason={sharedDisabledReason}
            actionPending={varaProgram.actionPending}
            onClearSession={
              varaProgram.onchainSession
                ? () => {
                    void varaProgram.revokeSession().catch(() => undefined);
                  }
                : null
            }
            onConnect={() => {
              if (!wallet.isConnected) {
                void wallet.connect().catch(() => undefined);
                return;
              }
              void varaProgram.createSession().catch(() => undefined);
            }}
            ready={programsOk && (wallet.isConnected ? varaProgram.isApiReady : wallet.isReady)}
            sessionLabel={varaSessionLabel}
          />
          <OrderForm
            asset={asset}
            availableCollateral={freeCollateral}
            availableNotional={availableNotional}
            currentPosition={varaProgram.onchainPosition}
            disabledReason={tradeDisabledReason}
            market={displayMarket}
            onSubmit={async (input) => {
              try {
                await varaProgram.openPosition(input);
              } catch {
                return;
              }
            }}
          />
          <AccountPanel
            account={snapshot.account}
            actionDisabled={!varaProgram.isVaraReady || !sessionReady}
            identityLabel={identity}
            actionReason={actionDisabledReason}
            onDeposit={async (amount) => {
              try {
                await varaProgram.deposit(amount);
              } catch {
                return;
              }
            }}
            onMint={async (amount) => {
              try {
                await varaProgram.mintDemoTokens(amount);
              } catch {
                return;
              }
            }}
            onProvideLiquidity={async (amount) => {
              try {
                await varaProgram.provideDemoLiquidity(amount);
              } catch {
                return;
              }
            }}
            onWithdraw={async (amount) => {
              try {
                await varaProgram.withdraw(amount);
              } catch {
                return;
              }
            }}
            sessionLabel={varaSessionLabel}
          />
        </aside>
      </div>

      <div className="bottom-row">
        <PositionsTable
          liveMarkPrice={livePrice}
          onClose={async (closeAsset) => {
            try {
              await varaProgram.closePosition(closeAsset);
            } catch {
              return;
            }
          }}
          positions={positions}
        />
      </div>
    </div>
  );
}
