import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import { usePolymarketOraclePrice, usePolymarketOraclePrices, type OraclePriceSnapshot } from "./hooks/usePolymarketOraclePrice";
import { useRecentTrades } from "./hooks/useRecentTrades";
import { useVaraEthProgram } from "./hooks/useVaraEthProgram";
import { useVaraEthWalletStatus } from "./hooks/useVaraEthWalletStatus";
import { useVaraProgram } from "./hooks/useVaraProgram";
import { useWalletStatus, type WalletStatus } from "./hooks/useWalletStatus";
import {
  VARA_RPC_URL,
  getAvailableAssetsForTradeMode,
  getMissingVaraEthProgramEnvKeys,
  getMissingVaraProgramEnvKeys
} from "./lib/config";
import { formatMoney } from "./lib/format";
import type {
  AccountSnapshot,
  Asset,
  Candle,
  EngineSnapshot,
  MarketSnapshot,
  OrderBookLevel,
  PositionSnapshot,
  RecentTrade,
  TradeMode,
  VaraEthExecutionMode
} from "./types";

const SIGNLESS_PREFERENCE_KEY = "varix:prefer-signless";
const TRADE_MODE_PREFERENCE_KEY = "varix:trade-mode";
const VARA_ETH_EXECUTION_MODE_PREFERENCE_KEY = "varix:vara-eth-execution-mode";
const MAX_DISPLAY_FUNDING_BPS = 75;

type PositionInput = Parameters<ReturnType<typeof useVaraProgram>["openPosition"]>[0];

type TradingViewProps = {
  accountNote: string | null;
  actionDisabled: boolean;
  actionDisabledReason: string | null;
  actionPending: boolean;
  asset: Asset;
  availableAssets: Asset[];
  availableCollateral: number;
  availableNotional: number;
  candles: Candle[];
  chartInterval: "5m" | "1h" | "1d";
  connectLabel: string;
  disabledReason: string | null;
  displayFundingBps: number | null;
  displayMarket: MarketSnapshot | null;
  freeCollateral: number;
  identity: string | null;
  isConnected: boolean;
  liveMarkPrice: number | null;
  liveOraclePrice: number | null;
  markets: MarketSnapshot[];
  missingProgramEnvKeys: string[];
  navWalletDisabled: boolean;
  navWalletTitle: string | null;
  onClearSession: (() => void) | null;
  onClosePosition: (position: PositionSnapshot) => Promise<void>;
  onConnect: () => void;
  onDeposit: (amount: number) => Promise<void>;
  onDisconnect: () => void;
  onFundGas: (() => void) | null;
  onIntervalChange: (value: "5m" | "1h" | "1d") => void;
  onMint: (amount: number) => Promise<void>;
  onOpenPosition: (input: PositionInput) => Promise<void>;
  onProvideLiquidity: (amount: number) => Promise<void>;
  onSelectAsset: (asset: Asset) => void;
  onSetSignlessMode: ((enabled: boolean) => void) | null;
  onTradeModeChange: (mode: TradeMode) => void;
  onWithdraw: (amount: number) => Promise<void>;
  orderBook: {
    asks: OrderBookLevel[];
    bids: OrderBookLevel[];
    updatedAt: number | null;
  };
  oraclePrices: Partial<Record<Asset, OraclePriceSnapshot>>;
  positions: PositionSnapshot[];
  programsOk: boolean;
  recentTrades: RecentTrade[];
  runtimeNote: string | null;
  runtimeReady: boolean;
  runtimeSessionLabel: string | null;
  sessionLabel: string | null;
  sharedDisabledReason: string | null;
  showSigningToggle: boolean;
  signlessAvailable: boolean;
  signlessEnabled: boolean;
  signlessModeEnabled: boolean;
  signlessToggleDisabled: boolean;
  snapshot: EngineSnapshot;
  statusBannerReason: string | null;
  tradeDisabledReason: string | null;
  tradeMode: TradeMode;
  walletModeToggle?: {
    ariaLabel: string;
    current: string;
    disabled?: boolean;
    onChange: (value: string) => void;
    options: Array<{ label: string; value: string }>;
  } | null;
  walletDetails?: ReactNode;
  walletLabel: string;
};

type SharedRuntimeProps = {
  asset: Asset;
  availableAssets: Asset[];
  candles: Candle[];
  chartInterval: "5m" | "1h" | "1d";
  liveMarkPrice: number | null;
  marketDataSnapshot: ReturnType<typeof useMarketState>;
  onAssetChange: (asset: Asset) => void;
  onChartIntervalChange: (value: "5m" | "1h" | "1d") => void;
  oraclePrice: ReturnType<typeof usePolymarketOraclePrice>;
  oraclePrices: Partial<Record<Asset, OraclePriceSnapshot>>;
  orderBook: ReturnType<typeof useOrderBook>;
  preferSignless: boolean;
  recentTrades: RecentTrade[];
  varaEthExecutionMode: VaraEthExecutionMode;
  setPreferSignless: (enabled: boolean) => void;
  setVaraEthExecutionMode: (mode: VaraEthExecutionMode) => void;
  setTradeMode: (mode: TradeMode) => void;
  tradeMode: TradeMode;
};

function formatOpenInterest(value: string | number, asset: Asset) {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(numeric)) {
    return "-";
  }

  const decimals = numeric >= 100 ? 0 : numeric >= 1 ? 2 : 4;
  return `${formatMoney(numeric, decimals)} ${asset}`;
}

function shortenMiddle(value: string, leading = 10, trailing = 8) {
  if (value.length <= leading + trailing + 1) {
    return value;
  }

  return `${value.slice(0, leading)}…${value.slice(-trailing)}`;
}

function buildHoodiAddressUrl(address: string | null) {
  return address ? `https://hoodi.etherscan.io/address/${address}` : null;
}

function buildHoodiTxUrl(hash: string | null) {
  return hash ? `https://hoodi.etherscan.io/tx/${hash}` : null;
}

function buildDisplayMarket(
  asset: Asset,
  market: MarketSnapshot | null,
  liveMarkPrice: number | null,
  oraclePrice: ReturnType<typeof usePolymarketOraclePrice>
) {
  if (!market) {
    if (liveMarkPrice === null && oraclePrice === null) {
      return null;
    }

    return {
      asset,
      markPrice: String(liveMarkPrice ?? oraclePrice?.price ?? 0),
      indexPrice: String(oraclePrice?.price ?? 0),
      fundingRateBps: 0,
      cumulativeFundingRateBps: 0,
      openInterestLong: "0",
      openInterestShort: "0",
      updatedAt: Date.now()
    } satisfies MarketSnapshot;
  }

  return {
    ...market,
    markPrice: String(liveMarkPrice ?? Number(market.markPrice)),
    indexPrice: String(oraclePrice?.price ?? Number(market.indexPrice)),
    updatedAt: Math.max(market.updatedAt, oraclePrice?.updatedAt ?? 0, Date.now())
  } satisfies MarketSnapshot;
}

function resolveDisplayOraclePrice(
  market: MarketSnapshot | null,
  oraclePrice: ReturnType<typeof usePolymarketOraclePrice>
) {
  const oracleValue = oraclePrice?.price ?? null;
  if (oracleValue !== null && Number.isFinite(oracleValue) && oracleValue > 0) {
    return oracleValue;
  }

  const marketIndexValue = market ? Number(market.indexPrice) : null;
  if (marketIndexValue !== null && Number.isFinite(marketIndexValue) && marketIndexValue > 0) {
    return marketIndexValue;
  }

  return null;
}

function resolveDisplayFundingBps(
  market: MarketSnapshot | null,
  liveMarkPrice: number | null,
  displayOraclePrice: number | null
) {
  if (market && Number.isFinite(market.fundingRateBps)) {
    return market.fundingRateBps;
  }

  if (liveMarkPrice === null || displayOraclePrice === null || displayOraclePrice <= 0) {
    return null;
  }

  const premiumBps = ((liveMarkPrice - displayOraclePrice) / displayOraclePrice) * 10_000;
  return Math.max(-MAX_DISPLAY_FUNDING_BPS, Math.min(MAX_DISPLAY_FUNDING_BPS, premiumBps));
}

function buildTradingView(props: TradingViewProps) {
  const {
    accountNote,
    actionDisabled,
    actionDisabledReason,
    actionPending,
    asset,
    availableAssets,
    availableCollateral,
    availableNotional,
    candles,
    chartInterval,
    connectLabel,
    disabledReason,
    displayFundingBps,
    displayMarket,
    identity,
    isConnected,
    liveMarkPrice,
    liveOraclePrice,
    markets,
    missingProgramEnvKeys,
    navWalletDisabled,
    navWalletTitle,
    onClearSession,
    onClosePosition,
    onConnect,
    onDeposit,
    onDisconnect,
    onFundGas,
    onIntervalChange,
    onMint,
    onOpenPosition,
    onProvideLiquidity,
    onSelectAsset,
    onSetSignlessMode,
    onTradeModeChange,
    onWithdraw,
    orderBook,
    oraclePrices,
    positions,
    programsOk,
    recentTrades,
    runtimeNote,
    runtimeReady,
    runtimeSessionLabel,
    sessionLabel,
    sharedDisabledReason,
    showSigningToggle,
    signlessAvailable,
    signlessEnabled,
    signlessModeEnabled,
    signlessToggleDisabled,
    snapshot,
    statusBannerReason,
    tradeDisabledReason,
    tradeMode,
    walletModeToggle,
    walletDetails,
    walletLabel
  } = props;

  const topMarketStats = [
    { label: "Mark", value: displayMarket ? formatMoney(displayMarket.markPrice, 1) : "-" },
    { label: "Oracle", value: liveOraclePrice !== null ? formatMoney(liveOraclePrice, 1) : "Waiting..." },
    { label: "Funding", value: displayFundingBps !== null ? `${(displayFundingBps / 100).toFixed(2)} bps` : "Waiting..." },
    { label: "OI Long", value: displayMarket ? formatOpenInterest(displayMarket.openInterestLong, asset) : "-" },
    { label: "OI Short", value: displayMarket ? formatOpenInterest(displayMarket.openInterestShort, asset) : "-" },
    { label: "LP", value: formatMoney(snapshot.liquidityPool.totalLiquidity, 0) },
    { label: "Reserved", value: formatMoney(snapshot.liquidityPool.reservedNotional, 0) },
    { label: "Max OI", value: formatMoney(snapshot.liquidityPool.maxOpenNotional, 0) }
  ];

  return (
    <div className="app-shell">
      <NavBar
        collateral={formatMoney(snapshot.account?.freeCollateral ?? 0)}
        identity={identity}
        isConnected={isConnected}
        tradeMode={tradeMode}
        walletCtaDisabled={navWalletDisabled}
        walletCtaLabel={connectLabel}
        walletCtaTitle={navWalletTitle}
        onTradeModeChange={onTradeModeChange}
        onDisconnect={onDisconnect}
        onFundGas={onFundGas}
        onScrollToAccount={() => {
          document
            .getElementById("varix-account")
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
        onWalletCta={onConnect}
      />

      {(!programsOk || statusBannerReason) && (
        <div className="status-banner">
          {!programsOk
            ? `Missing: ${missingProgramEnvKeys.join(", ")}. Set in web/.env.local.`
            : statusBannerReason}
        </div>
      )}

      <div className="market-ribbon">
        <MarketSelector
          activeAsset={asset}
          assets={availableAssets.length > 0 ? availableAssets : ["BTC", "ETH", "SOL"]}
          markets={markets}
          oraclePrices={oraclePrices}
          onSelect={onSelectAsset}
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
            onIntervalChange={onIntervalChange}
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
            connectLabel={connectLabel}
            disabledReason={sharedDisabledReason}
            actionPending={actionPending}
            note={runtimeNote}
            panelTitle={tradeMode === "vara" ? "Vara Wallet" : "Vara.eth Wallet"}
            onClearSession={onClearSession}
            onConnect={onConnect}
            ready={runtimeReady}
            runtimeLabel={tradeMode === "vara" ? "On-chain" : walletModeToggle?.current === "classic" ? "Classic L1" : "Injected"}
            showSigningToggle={showSigningToggle}
            statusLabel={tradeMode === "vara" ? "Session" : "Execution"}
            gaslessEnabled={tradeMode === "vara" ? signlessEnabled : false}
            signlessAvailable={signlessAvailable}
            signlessEnabled={signlessEnabled}
            signlessModeEnabled={signlessModeEnabled}
            signlessToggleDisabled={signlessToggleDisabled}
            modeToggle={walletModeToggle ?? null}
            onSetSignlessMode={onSetSignlessMode}
            sessionLabel={runtimeSessionLabel}
            details={walletDetails}
          />
          <OrderForm
            asset={asset}
            availableCollateral={availableCollateral}
            availableNotional={availableNotional}
            openPositions={positions.filter((position) => position.asset === asset)}
            disabledReason={tradeDisabledReason}
            market={displayMarket}
            onSubmit={async (input) => {
              await onOpenPosition(input);
            }}
          />
          <AccountPanel
            account={snapshot.account}
            actionDisabled={actionDisabled}
            identityLabel={identity}
            actionReason={actionDisabledReason}
            note={accountNote}
            onDeposit={async (amount) => {
              await onDeposit(amount);
            }}
            onMint={async (amount) => {
              await onMint(amount);
            }}
            onProvideLiquidity={async (amount) => {
              await onProvideLiquidity(amount);
            }}
            onWithdraw={async (amount) => {
              await onWithdraw(amount);
            }}
            sessionLabel={sessionLabel}
          />
        </aside>
      </div>

      <div className="bottom-row">
        <PositionsTable
          fundingRateBps={displayFundingBps}
          liveMarkPrice={liveMarkPrice}
          market={displayMarket}
          oraclePrice={liveOraclePrice}
          onClose={async (position) => {
            await onClosePosition(position);
          }}
          positions={positions}
          recentTrades={recentTrades}
        />
      </div>
    </div>
  );
}

function VaraModeView(props: SharedRuntimeProps) {
  const {
    asset,
    availableAssets,
    candles,
    chartInterval,
    liveMarkPrice,
    marketDataSnapshot,
    onAssetChange,
    onChartIntervalChange,
    oraclePrice,
    oraclePrices,
    orderBook,
    preferSignless,
    recentTrades,
    setPreferSignless,
    setTradeMode
  } = props;

  const wallet = useWalletStatus();
  const varaProgram = useVaraProgram(asset, "vara", null, liveMarkPrice, preferSignless);
  const [portfolioPositions, setPortfolioPositions] = useState<Partial<Record<Asset, PositionSnapshot[]>>>({});

  useEffect(() => {
    if (preferSignless && !varaProgram.hasSessionSigner) {
      setPreferSignless(false);
    }
  }, [preferSignless, setPreferSignless, varaProgram.hasSessionSigner]);

  const market = varaProgram.onchainMarket ?? marketDataSnapshot.market;
  const liveOraclePrice = resolveDisplayOraclePrice(market, oraclePrice);
  const displayMarket = useMemo(
    () => buildDisplayMarket(asset, market, liveMarkPrice, oraclePrice),
    [asset, liveMarkPrice, market, oraclePrice]
  );
  const displayFundingBps = useMemo(
    () => resolveDisplayFundingBps(market, liveMarkPrice, liveOraclePrice),
    [liveMarkPrice, liveOraclePrice, market]
  );
  const markets = useMemo(() => {
    const map = new Map(marketDataSnapshot.snapshot.markets.map((item) => [item.asset, item]));
    if (displayMarket) {
      map.set(displayMarket.asset, displayMarket);
    }
    for (const selectableAsset of availableAssets) {
      const price = oraclePrices[selectableAsset]?.price;
      if (!map.has(selectableAsset) && Number.isFinite(price) && price && price > 0) {
        map.set(selectableAsset, {
          asset: selectableAsset,
          markPrice: String(price),
          indexPrice: String(price),
          fundingRateBps: 0,
          cumulativeFundingRateBps: 0,
          openInterestLong: "0",
          openInterestShort: "0",
          updatedAt: oraclePrices[selectableAsset]?.updatedAt ?? Date.now()
        });
      }
    }
    return Array.from(map.values());
  }, [availableAssets, displayMarket, marketDataSnapshot.snapshot.markets, oraclePrices]);
  useEffect(() => {
    setPortfolioPositions((current) => ({
      ...current,
      [asset]: varaProgram.onchainPositions
    }));
  }, [asset, varaProgram.onchainPositions]);

  const activePositions = portfolioPositions[asset] ?? varaProgram.onchainPositions;
  const positions = useMemo(
    () => availableAssets.flatMap((positionAsset) => portfolioPositions[positionAsset] ?? []),
    [availableAssets, portfolioPositions]
  );
  const hasOpenPosition = activePositions.some((position) => position.asset === asset);
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

  const missingProgramEnvKeys = getMissingVaraProgramEnvKeys();
  const programsOk = missingProgramEnvKeys.length === 0;
  const sessionReady = Boolean(varaProgram.onchainSession);
  const rpcReason = programsOk && !varaProgram.isApiReady
    ? `Cannot reach Vara RPC at ${VARA_RPC_URL}. Start the local dev node.`
    : null;
  const sharedDisabledReason = !programsOk
    ? `Missing Vara env: ${missingProgramEnvKeys.join(", ")}.`
    : (rpcReason ?? wallet.disabledReason);
  const actionDisabledReason = sharedDisabledReason
    ?? (wallet.isConnected && varaProgram.isApiReady && preferSignless && !sessionReady
      ? "Register a session key first to enable signless mode."
      : null);
  const freeCollateral = Number(snapshot.account?.freeCollateral ?? 0);
  const maxOpenNotional = Number(snapshot.liquidityPool.maxOpenNotional ?? 0);
  const reservedNotional = Number(snapshot.liquidityPool.reservedNotional ?? 0);
  const availableNotional = Math.max(0, maxOpenNotional - reservedNotional);
  const tradeDisabledReason = actionDisabledReason
    ?? (sessionReady && freeCollateral <= 0 && !hasOpenPosition
      ? "Deposit collateral before trading."
      : freeCollateral <= 0 && !hasOpenPosition
        ? "Deposit collateral on Vara before trading."
        : availableNotional <= 0 && !hasOpenPosition
          ? "Fund LP before trading. The pool has no available capacity yet."
          : null);
  const identity = wallet.accountLabel;
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
  const varaSessionLabel = varaProgram.onchainSession
    ? `${varaProgram.hasSessionSigner ? "Signer ready" : "Wallet only"}${varaProgram.signlessModeEnabled ? " · Signless on" : " · Signless off"}${varaProgram.gaslessEnabled ? " · Gasless" : ""} · ${varaProgram.onchainSession.sessionKey.slice(0, 6)}…${varaProgram.onchainSession.sessionKey.slice(-4)}`
    : null;

  return buildTradingView({
    accountNote: null,
    actionDisabled: !varaProgram.isVaraReady || (preferSignless && !sessionReady),
    actionDisabledReason,
    actionPending: varaProgram.actionPending,
    asset,
    availableAssets,
    availableCollateral: freeCollateral,
    availableNotional,
    candles,
    chartInterval,
    connectLabel: navWalletLabel,
    disabledReason: sharedDisabledReason,
    displayFundingBps,
    displayMarket,
    freeCollateral,
    identity,
    isConnected: wallet.isConnected,
    liveMarkPrice,
    liveOraclePrice,
    markets,
    missingProgramEnvKeys,
    navWalletDisabled,
    navWalletTitle: sharedDisabledReason,
    onClearSession:
      varaProgram.onchainSession
        ? () => {
            void varaProgram.revokeSession().catch(() => undefined);
          }
        : null,
    onClosePosition: async (position) => {
      if (position.asset !== asset) {
        onAssetChange(position.asset);
        return;
      }
      await varaProgram.closePosition(position);
    },
    onConnect: () => {
      if (!wallet.isConnected) {
        void wallet.connect().catch(() => undefined);
        return;
      }
      void varaProgram.createSession().catch(() => undefined);
    },
    onDeposit: async (amount) => {
      await varaProgram.deposit(amount);
    },
    onDisconnect: wallet.disconnect,
    onFundGas: wallet.isConnected
      ? () => {
          void varaProgram.fundWalletGas().catch(() => undefined);
        }
      : null,
    onIntervalChange: onChartIntervalChange,
    onMint: async (amount) => {
      await varaProgram.mintDemoTokens(amount);
    },
    onOpenPosition: async (input) => {
      await varaProgram.openPosition(input);
    },
    onProvideLiquidity: async (amount) => {
      await varaProgram.provideDemoLiquidity(amount);
    },
    onSelectAsset: onAssetChange,
    onSetSignlessMode: setPreferSignless,
    onTradeModeChange: setTradeMode,
    onWithdraw: async (amount) => {
      await varaProgram.withdraw(amount);
    },
    orderBook,
    oraclePrices,
    positions,
    programsOk,
    recentTrades,
    runtimeNote: null,
    runtimeReady: programsOk && (wallet.isConnected ? varaProgram.isApiReady : wallet.isReady),
    runtimeSessionLabel: varaSessionLabel,
    sessionLabel: varaSessionLabel,
    sharedDisabledReason,
    showSigningToggle: true,
    signlessAvailable: varaProgram.hasSessionSigner,
    signlessEnabled: varaProgram.signlessEnabled,
    signlessModeEnabled: varaProgram.signlessModeEnabled,
    signlessToggleDisabled: varaProgram.actionPending || !wallet.isConnected,
    snapshot,
    statusBannerReason: rpcReason,
    tradeDisabledReason,
    tradeMode: "vara",
    walletModeToggle: null,
    walletDetails: null,
    walletLabel: "Vara Wallet"
  });
}

function VaraEthModeView(props: SharedRuntimeProps) {
  const {
    asset,
    availableAssets,
    candles,
    chartInterval,
    liveMarkPrice,
    marketDataSnapshot,
    onAssetChange,
    onChartIntervalChange,
    oraclePrice,
    oraclePrices,
    orderBook,
    recentTrades,
    varaEthExecutionMode,
    setVaraEthExecutionMode,
    setTradeMode
  } = props;

  const wallet = useVaraEthWalletStatus();
  const varaEthProgram = useVaraEthProgram(asset, wallet.address, liveMarkPrice, true, varaEthExecutionMode);
  const [portfolioPositions, setPortfolioPositions] = useState<Partial<Record<Asset, PositionSnapshot[]>>>({});

  const market = varaEthProgram.onchainMarket ?? marketDataSnapshot.market;
  const liveOraclePrice = resolveDisplayOraclePrice(market, oraclePrice);
  const displayMarket = useMemo(
    () => buildDisplayMarket(asset, market, liveMarkPrice, oraclePrice),
    [asset, liveMarkPrice, market, oraclePrice]
  );
  const displayFundingBps = useMemo(
    () => resolveDisplayFundingBps(market, liveMarkPrice, liveOraclePrice),
    [liveMarkPrice, liveOraclePrice, market]
  );
  const markets = useMemo(() => {
    const map = new Map(marketDataSnapshot.snapshot.markets.map((item) => [item.asset, item]));
    if (displayMarket) {
      map.set(displayMarket.asset, displayMarket);
    }
    for (const selectableAsset of availableAssets) {
      const price = oraclePrices[selectableAsset]?.price;
      if (!map.has(selectableAsset) && Number.isFinite(price) && price && price > 0) {
        map.set(selectableAsset, {
          asset: selectableAsset,
          markPrice: String(price),
          indexPrice: String(price),
          fundingRateBps: 0,
          cumulativeFundingRateBps: 0,
          openInterestLong: "0",
          openInterestShort: "0",
          updatedAt: oraclePrices[selectableAsset]?.updatedAt ?? Date.now()
        });
      }
    }
    return Array.from(map.values());
  }, [availableAssets, displayMarket, marketDataSnapshot.snapshot.markets, oraclePrices]);
  useEffect(() => {
    setPortfolioPositions((current) => ({
      ...current,
      [asset]: varaEthProgram.onchainPositions
    }));
  }, [asset, varaEthProgram.onchainPositions]);

  const activePositions = portfolioPositions[asset] ?? varaEthProgram.onchainPositions;
  const positions = useMemo(
    () => availableAssets.flatMap((positionAsset) => portfolioPositions[positionAsset] ?? []),
    [availableAssets, portfolioPositions]
  );
  const hasOpenPosition = activePositions.some((position) => position.asset === asset);
  const snapshot = useMemo(
    () => ({
      ...marketDataSnapshot.snapshot,
      account: varaEthProgram.onchainAccount,
      liquidityPool: varaEthProgram.onchainPool
        ? {
            totalLiquidity: varaEthProgram.onchainPool.totalLiquidity,
            maxOpenNotional: varaEthProgram.onchainPool.maxOpenNotional,
            reservedNotional: varaEthProgram.onchainPool.reservedNotional
          }
        : marketDataSnapshot.snapshot.liquidityPool,
      session: null
    }),
    [marketDataSnapshot.snapshot, varaEthProgram.onchainAccount, varaEthProgram.onchainPool]
  );

  const missingProgramEnvKeys = getMissingVaraEthProgramEnvKeys();
  const programsOk = missingProgramEnvKeys.length === 0;
  const varaEthReason = programsOk && wallet.isConnected && !varaEthProgram.isApiReady
    ? "Connecting to Vara.eth RPC and mirror programs..."
    : null;
  const sharedDisabledReason = !programsOk
    ? `Missing Vara.eth env: ${missingProgramEnvKeys.join(", ")}.`
    : (wallet.disabledReason ?? varaEthReason);
  const freeCollateral = Number(snapshot.account?.freeCollateral ?? 0);
  const maxOpenNotional = Number(snapshot.liquidityPool.maxOpenNotional ?? 0);
  const reservedNotional = Number(snapshot.liquidityPool.reservedNotional ?? 0);
  const availableNotional = Math.max(0, maxOpenNotional - reservedNotional);
  const tradeDisabledReason = sharedDisabledReason
    ?? (freeCollateral <= 0 && !hasOpenPosition
      ? "Deposit collateral on Vara.eth before trading."
      : availableNotional <= 0 && !hasOpenPosition
        ? "Fund LP before trading. The pool has no available capacity yet."
        : null);
  const varaEthExecutionLabel = wallet.isConnected
    ? varaEthExecutionMode === "injected"
      ? varaEthProgram.syncPending
        ? varaEthProgram.actionPreconfirmed
          ? "Pre-confirmed · syncing live state"
          : "Accepted · awaiting promise"
        : varaEthProgram.actionPreconfirmed
          ? "Pre-confirmed"
          : varaEthProgram.actionPending
            ? "Injected tx pending"
            : "Injected EVM signer"
      : varaEthProgram.syncPending
        ? "Reply confirmed · syncing live state"
        : varaEthProgram.actionPending
          ? "Classic tx pending"
          : "Classic Hoodi signer"
    : null;
  const activeActionNote = varaEthProgram.actionStatusMessage
    ?? varaEthProgram.syncStatusMessage
    ?? (!sharedDisabledReason
      ? varaEthExecutionMode === "injected"
        ? "Injected mode uses validator-signed Vara.eth pre-confirmations, then refreshes live Vara.eth state."
        : "Classic mode sends a real Hoodi transaction to the program mirror and waits for the Vara.eth reply."
      : null);
  const copyValue = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Ignore clipboard failures in unsupported browsers.
    }
  };
  const hoodiSignerUrl = buildHoodiAddressUrl(wallet.address);
  const hoodiTxUrl = buildHoodiTxUrl(varaEthProgram.lastEthereumTxHash);
  const hoodiReplyTxUrl = buildHoodiTxUrl(varaEthProgram.lastReplyTxHash);
  const walletDetails =
    wallet.isConnected
    || wallet.providerLabel
    || varaEthProgram.lastInjectedTxHash
    || varaEthProgram.lastValidatorAddress
    || varaEthProgram.lastEthereumTxHash
    || varaEthProgram.lastReplyTxHash
    ? (
      <>
        {wallet.providerLabel ? (
          <div className="wallet-detail-row">
            <span className="wallet-detail-label">Provider</span>
            <span className="wallet-detail-value">{wallet.providerLabel}</span>
          </div>
        ) : null}
        {varaEthProgram.runtimeWarning ? (
          <div className="wallet-detail-row">
            <span className="wallet-detail-label">Read Status</span>
            <span className="wallet-detail-value">{varaEthProgram.runtimeWarning}</span>
          </div>
        ) : null}
        {wallet.address ? (
          <div className="wallet-detail-row">
            <span className="wallet-detail-label">Signer</span>
            <span className="wallet-detail-value" title={wallet.address}>{shortenMiddle(wallet.address)}</span>
            <span className="wallet-detail-actions">
              <button className="wallet-detail-button" onClick={() => { void copyValue(wallet.address!); }} type="button">
                Copy
              </button>
              {hoodiSignerUrl ? (
                <a className="wallet-detail-link" href={hoodiSignerUrl} rel="noreferrer" target="_blank">
                  Hoodi
                </a>
              ) : null}
            </span>
          </div>
        ) : null}
        {varaEthExecutionMode === "injected" && varaEthProgram.lastValidatorAddress ? (
          <div className="wallet-detail-row">
            <span className="wallet-detail-label">Validator</span>
            <span className="wallet-detail-value" title={varaEthProgram.lastValidatorAddress}>
              {shortenMiddle(varaEthProgram.lastValidatorAddress)}
            </span>
            <span className="wallet-detail-actions">
              <button className="wallet-detail-button" onClick={() => { void copyValue(varaEthProgram.lastValidatorAddress!); }} type="button">
                Copy
              </button>
            </span>
          </div>
        ) : null}
        {varaEthExecutionMode === "injected" && varaEthProgram.lastInjectedTxHash ? (
          <div className="wallet-detail-row">
            <span className="wallet-detail-label">Injected ID</span>
            <span className="wallet-detail-value">
              <span title={varaEthProgram.lastInjectedTxHash}>{shortenMiddle(varaEthProgram.lastInjectedTxHash, 12, 10)}</span>
            </span>
            <span className="wallet-detail-actions">
              <button className="wallet-detail-button" onClick={() => { void copyValue(varaEthProgram.lastInjectedTxHash!); }} type="button">
                Copy
              </button>
              {varaEthProgram.lastInjectedTxTrackerUrl ? (
                <a
                  className="wallet-detail-link"
                  href={varaEthProgram.lastInjectedTxTrackerUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Track
                </a>
              ) : null}
            </span>
          </div>
        ) : null}
        {varaEthExecutionMode === "classic" && varaEthProgram.lastEthereumTxHash ? (
          <div className="wallet-detail-row">
            <span className="wallet-detail-label">Hoodi Tx</span>
            <span className="wallet-detail-value">
              <span title={varaEthProgram.lastEthereumTxHash}>{shortenMiddle(varaEthProgram.lastEthereumTxHash, 12, 10)}</span>
            </span>
            <span className="wallet-detail-actions">
              <button className="wallet-detail-button" onClick={() => { void copyValue(varaEthProgram.lastEthereumTxHash!); }} type="button">
                Copy
              </button>
              {hoodiTxUrl ? (
                <a className="wallet-detail-link" href={hoodiTxUrl} rel="noreferrer" target="_blank">
                  Hoodi
                </a>
              ) : null}
            </span>
          </div>
        ) : null}
        {varaEthExecutionMode === "classic" && varaEthProgram.lastReplyTxHash ? (
          <div className="wallet-detail-row">
            <span className="wallet-detail-label">Reply Tx</span>
            <span className="wallet-detail-value">
              <span title={varaEthProgram.lastReplyTxHash}>{shortenMiddle(varaEthProgram.lastReplyTxHash, 12, 10)}</span>
            </span>
            <span className="wallet-detail-actions">
              <button className="wallet-detail-button" onClick={() => { void copyValue(varaEthProgram.lastReplyTxHash!); }} type="button">
                Copy
              </button>
              {hoodiReplyTxUrl ? (
                <a className="wallet-detail-link" href={hoodiReplyTxUrl} rel="noreferrer" target="_blank">
                  Hoodi
                </a>
              ) : null}
            </span>
          </div>
        ) : null}
      </>
    )
    : null;

  return buildTradingView({
    accountNote: activeActionNote,
    actionDisabled: !varaEthProgram.isVaraEthReady || !varaEthProgram.isApiReady,
    actionDisabledReason: sharedDisabledReason ?? varaEthReason,
    actionPending: varaEthProgram.actionPending,
    asset,
    availableAssets,
    availableCollateral: freeCollateral,
    availableNotional,
    candles,
    chartInterval,
    connectLabel: wallet.connectLabel,
    disabledReason: sharedDisabledReason,
    displayFundingBps,
    displayMarket,
    freeCollateral,
    identity: wallet.accountLabel,
    isConnected: wallet.isConnected,
    liveMarkPrice,
    liveOraclePrice,
    markets,
    missingProgramEnvKeys,
    navWalletDisabled: varaEthProgram.actionPending || (!wallet.isConnected && !wallet.isReady),
    navWalletTitle: sharedDisabledReason,
    onClearSession: null,
    onClosePosition: async (position) => {
      if (position.asset !== asset) {
        onAssetChange(position.asset);
        return;
      }
      await varaEthProgram.closePosition(position);
    },
    onConnect: () => {
      void wallet.connect().catch(() => undefined);
    },
    onDeposit: async (amount) => {
      await varaEthProgram.deposit(amount);
    },
    onDisconnect: wallet.disconnect,
    onFundGas: null,
    onIntervalChange: onChartIntervalChange,
    onMint: async (amount) => {
      await varaEthProgram.mintDemoTokens(amount);
    },
    onOpenPosition: async (input) => {
      await varaEthProgram.openPosition(input);
    },
    onProvideLiquidity: async (amount) => {
      await varaEthProgram.provideDemoLiquidity(amount);
    },
    onSelectAsset: onAssetChange,
    onSetSignlessMode: null,
    onTradeModeChange: setTradeMode,
    onWithdraw: async (amount) => {
      await varaEthProgram.withdraw(amount);
    },
    orderBook,
    oraclePrices,
    positions,
    programsOk,
    recentTrades,
    runtimeNote: varaEthProgram.actionStatusMessage
      ?? varaEthProgram.syncStatusMessage
      ?? (!sharedDisabledReason
        ? varaEthExecutionMode === "injected"
          ? "Injected Vara.eth mode is active. Reads come from Vara.eth RPC and successful actions wait for a real validator-signed pre-confirmation before state refresh."
          : "Classic Vara.eth mode is active. Writes go through Hoodi as real Ethereum transactions and then wait for the Vara.eth reply."
        : null),
    runtimeReady: programsOk && (!wallet.isConnected || varaEthProgram.isApiReady),
    runtimeSessionLabel: varaEthExecutionLabel,
    sessionLabel: varaEthExecutionLabel,
    sharedDisabledReason,
    showSigningToggle: false,
    signlessAvailable: false,
    signlessEnabled: false,
    signlessModeEnabled: false,
    signlessToggleDisabled: true,
    snapshot,
    statusBannerReason: varaEthReason,
    tradeDisabledReason,
    tradeMode: "vara-eth",
    walletModeToggle: {
      ariaLabel: "Vara.eth execution mode",
      current: varaEthExecutionMode,
      disabled: varaEthProgram.actionPending,
      onChange: (value) => setVaraEthExecutionMode(value as VaraEthExecutionMode),
      options: [
        { label: "Injected", value: "injected" },
        { label: "Classic", value: "classic" }
      ]
    },
    walletDetails,
    walletLabel: "Vara.eth Wallet"
  });
}

export default function App() {
  const [asset, setAsset] = useState<Asset>("BTC");
  const [chartInterval, setChartInterval] = useState<"5m" | "1h" | "1d">("1h");
  const [tradeMode, setTradeMode] = useState<TradeMode>(() => {
    if (typeof window === "undefined") {
      return "vara";
    }

    return window.localStorage.getItem(TRADE_MODE_PREFERENCE_KEY) === "vara-eth" ? "vara-eth" : "vara";
  });
  const [preferSignless, setPreferSignless] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }

    return window.localStorage.getItem(SIGNLESS_PREFERENCE_KEY) === "true";
  });
  const [varaEthExecutionMode, setVaraEthExecutionMode] = useState<VaraEthExecutionMode>(() => {
    if (typeof window === "undefined") {
      return "injected";
    }

    return window.localStorage.getItem(VARA_ETH_EXECUTION_MODE_PREFERENCE_KEY) === "classic"
      ? "classic"
      : "injected";
  });

  const availableAssets = useMemo(() => getAvailableAssetsForTradeMode(tradeMode), [tradeMode]);
  const marketDataSnapshot = useMarketState(asset, null);
  const candles = useCandles(asset, chartInterval);
  const orderBook = useOrderBook(asset);
  const recentTrades = useRecentTrades(asset);
  const oraclePrice = usePolymarketOraclePrice(asset);
  const oraclePrices = usePolymarketOraclePrices(availableAssets.length > 0 ? availableAssets : ["BTC", "ETH", "SOL"]);
  const liveMarkPrice = useMemo(() => {
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

  useEffect(() => {
    const nextAsset = availableAssets[0];
    if (nextAsset && !availableAssets.includes(asset)) {
      setAsset(nextAsset);
    }
  }, [asset, availableAssets]);

  useEffect(() => {
    window.localStorage.setItem(SIGNLESS_PREFERENCE_KEY, preferSignless ? "true" : "false");
  }, [preferSignless]);

  useEffect(() => {
    window.localStorage.setItem(TRADE_MODE_PREFERENCE_KEY, tradeMode);
    window.dispatchEvent(new CustomEvent("varix:trade-mode-change", { detail: tradeMode }));
  }, [tradeMode]);

  useEffect(() => {
    window.localStorage.setItem(VARA_ETH_EXECUTION_MODE_PREFERENCE_KEY, varaEthExecutionMode);
  }, [varaEthExecutionMode]);

  const sharedProps: SharedRuntimeProps = {
    asset,
    availableAssets,
    candles,
    chartInterval,
    liveMarkPrice,
    marketDataSnapshot,
    onAssetChange: setAsset,
    onChartIntervalChange: setChartInterval,
    oraclePrice,
    oraclePrices,
    orderBook,
    preferSignless,
    recentTrades,
    varaEthExecutionMode,
    setPreferSignless,
    setVaraEthExecutionMode,
    setTradeMode,
    tradeMode
  };

  return tradeMode === "vara"
    ? <VaraModeView {...sharedProps} />
    : <VaraEthModeView {...sharedProps} />;
}
