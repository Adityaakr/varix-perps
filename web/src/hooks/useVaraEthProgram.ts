import { createVaraEthApi, getMirrorClient, InjectedTxPromise, ReplyCode, WsVaraEthProvider } from "@vara-eth/api";
import { walletClientToSigner } from "@vara-eth/api/signer";
import { Sails } from "sails-js";
import { SailsIdlParser } from "sails-js-parser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { createPublicClient, createWalletClient, custom, http } from "viem";
import demoUsdcIdl from "../idl/demo-usdc-vft.idl?raw";
import liquidityPoolIdl from "../idl/liquidity-pool.idl?raw";
import marginVaultIdl from "../idl/margin-vault.idl?raw";
import perpMarketIdl from "../idl/perp-market.idl?raw";
import {
  VARA_ETH_CHAIN_ID,
  VARA_ETH_DEMO_USDC_PROGRAM_ID,
  VARA_ETH_ETH_RPC_URL,
  VARA_ETH_INJECTED_EXPLORER_BASE_URL,
  VARA_ETH_LIQUIDITY_POOL_PROGRAM_ID,
  VARA_ETH_MARGIN_VAULT_PROGRAM_ID,
  VARA_ETH_ROUTER_ADDRESS,
  VARA_ETH_VARA_RPC_URL,
  getMissingVaraEthProgramEnvKeys,
  getVaraEthMarketProgramId
} from "../lib/config";
import { getPreferredEvmProvider } from "../lib/evmProvider";
import type {
  AccountSnapshot,
  Asset,
  MarketSnapshot,
  PositionSnapshot,
  VaraEthExecutionMode,
  VaraAccountSnapshot,
  VaraLpAccount,
  VaraMarketSnapshot,
  VaraOpenPositionSnapshot,
  VaraPoolState
} from "../types";

const PRICE_SCALE = 100_000_000n;
const PRICE_TO_COLLATERAL_SCALE = 100n;
const SIZE_FROM_NOTIONAL_SCALE = PRICE_SCALE * PRICE_TO_COLLATERAL_SCALE;
const MAX_U128 = (1n << 128n) - 1n;
const POSITION_OVERRIDE_STORAGE_PREFIX = "varix:vara-eth-position-display-overrides:";
const MIRROR_VISIBILITY_TIMEOUT_MS = 45_000;
const MIRROR_VISIBILITY_POLL_MS = 1_000;
const INJECTED_WATCH_SUBSCRIBE = "injected_sendTransactionAndWatch";
const INJECTED_WATCH_UNSUBSCRIBE = "injected_sendTransactionAndWatchUnsubscribe";
const VARA_ETH_CHAIN = VARA_ETH_CHAIN_ID > 0
  ? {
      id: VARA_ETH_CHAIN_ID,
      name: "Vara.eth Hoodi",
      nativeCurrency: {
        name: "Ethereum",
        symbol: "ETH",
        decimals: 18
      },
      rpcUrls: {
        default: {
          http: [VARA_ETH_ETH_RPC_URL]
        }
      }
    }
  : undefined;

type PositionInput = {
  side: "long" | "short";
  notional: number;
  leverage: number;
  maxSlippageBps: number;
};

type VaraEthActionHelpers = {
  setPreconfirmed: (message: string) => void;
  setSubmitted: (message: string, applyOptimistic?: () => void) => void;
  startBackgroundSync: (message: string, task: () => Promise<void>) => void;
  setSyncing: (message: string) => void;
  setStage: (message: string) => void;
};

type VaraEthContext = {
  api: Awaited<ReturnType<typeof createVaraEthApi>>;
  marketProgram: Sails;
  poolProgram: Sails;
  publicClient: any;
  signer: any;
  tokenProgram: Sails;
  vaultProgram: Sails;
};

type InjectedPromiseResult = {
  code: { isError: boolean; reason: string };
  txHash?: Hex | null;
  validatorAddress?: Address | null;
  validateSignature: () => Promise<void>;
};

type OptimisticSnapshot = {
  account: AccountSnapshot | null;
  market: MarketSnapshot | null;
  positions: PositionSnapshot[];
  pool: { totalLiquidity: string; maxOpenNotional: string; reservedNotional: string } | null;
};

let sailsParserPromise: Promise<SailsIdlParser> | null = null;

function formatUnits(value: bigint, decimals: number) {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const factor = 10n ** BigInt(decimals);
  const whole = abs / factor;
  const fraction = abs % factor;
  const raw = `${whole}.${fraction.toString().padStart(decimals, "0")}`;
  const trimmed = raw.replace(/\.?0+$/, "");
  return negative ? `-${trimmed}` : trimmed;
}

function toBigInt(value: bigint | number | string | { toString(): string }) {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string") {
    return BigInt(value);
  }
  return BigInt(value.toString());
}

function decimalToBigInt(value: number, decimals: number) {
  return BigInt(Math.round(value * 10 ** decimals));
}

function decimalStringToBigInt(value: string, decimals: number) {
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-");
  const normalized = negative ? trimmed.slice(1) : trimmed;
  const [wholePart, fractionPart = ""] = normalized.split(".");
  const safeWhole = wholePart === "" ? "0" : wholePart;
  const paddedFraction = `${fractionPart}0`.slice(0, decimals);
  const combined = `${safeWhole}${paddedFraction.padEnd(decimals, "0")}`;
  const numeric = BigInt(combined === "" ? "0" : combined);
  return negative ? -numeric : numeric;
}

function divCeil(value: bigint, divisor: bigint) {
  return (value + divisor - 1n) / divisor;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function evmAddressToActorId(address: Address) {
  return `0x${address.slice(2).padStart(64, "0")}` as Hex;
}

function parseTraderAccount(
  account: VaraAccountSnapshot,
  walletBalance: bigint | number | string | { toString(): string },
  lpShares: bigint | number | string | { toString(): string }
): AccountSnapshot {
  const freeValue = toBigInt(account.free);
  const lockedValue = toBigInt(account.locked);
  const walletBalanceValue = toBigInt(walletBalance);
  const lpSharesValue = toBigInt(lpShares);
  const free = formatUnits(freeValue, 6);
  const locked = formatUnits(lockedValue, 6);
  const equityValue = freeValue + lockedValue;

  return {
    trader: "wallet",
    walletBalance: formatUnits(walletBalanceValue, 6),
    freeCollateral: free,
    lockedCollateral: locked,
    equity: formatUnits(equityValue, 6),
    realizedPnl: "0",
    totalDeposited: free,
    totalWithdrawn: "0",
    lpShares: formatUnits(lpSharesValue, 6)
  };
}

function parsePoolState(state: VaraPoolState) {
  return {
    totalLiquidity: formatUnits(toBigInt(state.total_liquidity), 6),
    maxOpenNotional: formatUnits(toBigInt(state.max_capacity), 6),
    reservedNotional: formatUnits(toBigInt(state.reserved_notional), 6)
  };
}

function parseMarket(asset: Asset, market: VaraMarketSnapshot): MarketSnapshot {
  return {
    asset,
    markPrice: formatUnits(toBigInt(market.mark_price), 8),
    indexPrice: formatUnits(toBigInt(market.index_price), 8),
    fundingRateBps: Number(toBigInt(market.funding_rate_bps)),
    cumulativeFundingRateBps: Number(toBigInt(market.cumulative_funding_rate_bps)),
    openInterestLong: formatUnits(toBigInt(market.open_interest_long), 8),
    openInterestShort: formatUnits(toBigInt(market.open_interest_short), 8),
    updatedAt: Date.now()
  };
}

function parsePosition(
  asset: Asset,
  market: VaraMarketSnapshot,
  openPosition: VaraOpenPositionSnapshot,
  displayEntryOverride?: bigint | null
): PositionSnapshot {
  const position = openPosition.position;
  const positionSize = toBigInt(position.size);
  const mark = toBigInt(market.mark_price);
  const entry = toBigInt(position.entry_price);
  const displayEntry = displayEntryOverride ?? entry;
  const margin = toBigInt(position.margin);
  const openedAt = toBigInt(position.opened_at);
  const side = positionSize >= 0n ? "long" : "short";
  const size = positionSize >= 0n ? positionSize : -positionSize;
  const pnlBase = (mark - displayEntry) * positionSize;
  const pnl = pnlBase / PRICE_SCALE / PRICE_TO_COLLATERAL_SCALE;
  const liquidationPrice = size === 0n
    ? displayEntry
    : side === "long"
      ? displayEntry - (margin * PRICE_SCALE * PRICE_TO_COLLATERAL_SCALE) / size
      : displayEntry + (margin * PRICE_SCALE * PRICE_TO_COLLATERAL_SCALE) / size;

  return {
    id: Number(toBigInt(openPosition.id)),
    trader: openPosition.trader,
    asset,
    side,
    size: formatUnits(size, 8),
    notional: formatUnits((size * mark) / PRICE_SCALE / PRICE_TO_COLLATERAL_SCALE, 6),
    entryPrice: formatUnits(displayEntry, 8),
    markPrice: formatUnits(mark, 8),
    margin: formatUnits(margin, 6),
    leverage: Number(position.leverage),
    liquidationPrice: formatUnits(liquidationPrice, 8),
    pnl: formatUnits(pnl, 6),
    updatedAt: Number(openedAt)
  };
}

type PositionDisplayOverride = {
  entryPrice: string;
};

function positionOverrideKey(asset: Asset, positionId: number) {
  return `${asset}:${positionId}`;
}

function readPositionDisplayOverrides(owner: string): Record<string, PositionDisplayOverride> {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(`${POSITION_OVERRIDE_STORAGE_PREFIX}${owner}`);
    return raw ? JSON.parse(raw) as Record<string, PositionDisplayOverride> : {};
  } catch {
    return {};
  }
}

function writePositionDisplayOverride(owner: string, asset: Asset, positionId: number, entryPrice: string) {
  if (typeof window === "undefined") {
    return;
  }

  const overrides = readPositionDisplayOverrides(owner);
  overrides[positionOverrideKey(asset, positionId)] = { entryPrice };
  window.localStorage.setItem(`${POSITION_OVERRIDE_STORAGE_PREFIX}${owner}`, JSON.stringify(overrides));
}

function deletePositionDisplayOverride(owner: string, asset: Asset, positionId: number) {
  if (typeof window === "undefined") {
    return;
  }

  const overrides = readPositionDisplayOverrides(owner);
  delete overrides[positionOverrideKey(asset, positionId)];
  window.localStorage.setItem(`${POSITION_OVERRIDE_STORAGE_PREFIX}${owner}`, JSON.stringify(overrides));
}

function adjustAccountSnapshot(
  snapshot: AccountSnapshot,
  deltas: {
    walletBalance?: bigint;
    freeCollateral?: bigint;
    lockedCollateral?: bigint;
    lpShares?: bigint;
  }
) {
  const walletBalance = decimalStringToBigInt(snapshot.walletBalance, 6) + (deltas.walletBalance ?? 0n);
  const freeCollateral = decimalStringToBigInt(snapshot.freeCollateral, 6) + (deltas.freeCollateral ?? 0n);
  const lockedCollateral = decimalStringToBigInt(snapshot.lockedCollateral, 6) + (deltas.lockedCollateral ?? 0n);
  const lpShares = decimalStringToBigInt(snapshot.lpShares, 6) + (deltas.lpShares ?? 0n);
  const equity = freeCollateral + lockedCollateral;

  return {
    ...snapshot,
    walletBalance: formatUnits(walletBalance, 6),
    freeCollateral: formatUnits(freeCollateral, 6),
    lockedCollateral: formatUnits(lockedCollateral, 6),
    equity: formatUnits(equity, 6),
    totalDeposited: formatUnits(freeCollateral, 6),
    lpShares: formatUnits(lpShares, 6)
  } satisfies AccountSnapshot;
}

function adjustPoolSnapshot(
  snapshot: { totalLiquidity: string; maxOpenNotional: string; reservedNotional: string },
  deltas: { totalLiquidity?: bigint; reservedNotional?: bigint }
) {
  const totalLiquidity = decimalStringToBigInt(snapshot.totalLiquidity, 6) + (deltas.totalLiquidity ?? 0n);
  const reservedNotional = decimalStringToBigInt(snapshot.reservedNotional, 6) + (deltas.reservedNotional ?? 0n);
  const currentLiquidity = decimalStringToBigInt(snapshot.totalLiquidity, 6);
  const currentCapacity = decimalStringToBigInt(snapshot.maxOpenNotional, 6);
  const maxOpenNotional =
    currentLiquidity > 0n
      ? (currentCapacity * totalLiquidity) / currentLiquidity
      : totalLiquidity * 5n;

  return {
    totalLiquidity: formatUnits(totalLiquidity, 6),
    maxOpenNotional: formatUnits(maxOpenNotional, 6),
    reservedNotional: formatUnits(reservedNotional, 6)
  };
}

function adjustMarketSnapshot(
  snapshot: MarketSnapshot,
  deltas: { openInterestLong?: bigint; openInterestShort?: bigint }
) {
  const openInterestLong = decimalStringToBigInt(snapshot.openInterestLong, 8) + (deltas.openInterestLong ?? 0n);
  const openInterestShort = decimalStringToBigInt(snapshot.openInterestShort, 8) + (deltas.openInterestShort ?? 0n);

  return {
    ...snapshot,
    openInterestLong: formatUnits(openInterestLong, 8),
    openInterestShort: formatUnits(openInterestShort, 8),
    updatedAt: Date.now()
  } satisfies MarketSnapshot;
}

function buildOptimisticPosition(
  id: number,
  trader: string,
  asset: Asset,
  side: "long" | "short",
  size: bigint,
  markPrice: bigint,
  margin: bigint,
  leverage: number
) {
  const liquidationPrice = side === "long"
    ? markPrice - (margin * PRICE_SCALE * PRICE_TO_COLLATERAL_SCALE) / size
    : markPrice + (margin * PRICE_SCALE * PRICE_TO_COLLATERAL_SCALE) / size;

  return {
    id,
    trader,
    asset,
    side,
    size: formatUnits(size, 8),
    notional: formatUnits((size * markPrice) / PRICE_SCALE / PRICE_TO_COLLATERAL_SCALE, 6),
    entryPrice: formatUnits(markPrice, 8),
    markPrice: formatUnits(markPrice, 8),
    margin: formatUnits(margin, 6),
    leverage,
    liquidationPrice: formatUnits(liquidationPrice, 8),
    pnl: "0",
    updatedAt: Date.now()
  } satisfies PositionSnapshot;
}

async function getSailsParser() {
  if (!sailsParserPromise) {
    sailsParserPromise = SailsIdlParser.new();
  }

  return sailsParserPromise;
}

async function createSailsProgram(idl: string) {
  const parser = await getSailsParser();
  return new Sails(parser).parseIdl(idl);
}

function describeError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown Vara.eth error";
  }
}

function buildInjectedTxTrackerUrl(txHash: string | null) {
  if (!txHash || !VARA_ETH_INJECTED_EXPLORER_BASE_URL) {
    return null;
  }

  if (VARA_ETH_INJECTED_EXPLORER_BASE_URL.includes("{hash}")) {
    return VARA_ETH_INJECTED_EXPLORER_BASE_URL.replace("{hash}", txHash);
  }

  return `${VARA_ETH_INJECTED_EXPLORER_BASE_URL.replace(/\/+$/, "")}/${txHash}`;
}

async function waitForValue<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  attempts = 6,
  delayMs = 750
) {
  let lastValue: T | null = null;

  for (let index = 0; index < attempts; index += 1) {
    const value = await read();
    lastValue = value;
    if (predicate(value)) {
      return value;
    }
    await sleep(delayMs);
  }

  return lastValue;
}

function isTransientNetworkError(error: unknown) {
  const message = describeError(error).toLowerCase();
  return (
    message.includes("network changed") ||
    message.includes("internet disconnected") ||
    message.includes("fetch failed") ||
    message.includes("failed to fetch") ||
    message.includes("timeout") ||
    message.includes("websocket") ||
    message.includes("connection closed") ||
    message.includes("connection refused") ||
    message.includes("failed to connect") ||
    message.includes("socket hang up") ||
    message.includes("disconnect") ||
    message.includes("connect") ||
    message.includes("ecconnreset") ||
    message.includes("econnrefused") ||
    message.includes("enotfound")
  );
}

function isQueryOutOfGasError(error: unknown) {
  return describeError(error).toLowerCase().includes("ran out of gas");
}

function assertReplySuccess(reply: { code: { isError: boolean; reason: string } }) {
  if (reply.code.isError) {
    throw new Error(reply.code.reason);
  }
}

async function sendInjectedWithStages(
  injected: any,
  watchContext: {
    ethClient: unknown;
    provider: any;
  },
  setStage: (message: string) => void,
  afterAccept?: (txHash: string | null) => void | Promise<void>
) {
  let unsubscribe: (() => void) | undefined;
  let resolvePromise: ((value: InjectedPromiseResult) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const watchedPromise = new Promise<InjectedPromiseResult>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  setStage("Waiting for wallet signature...");
  if (typeof injected.setDefaultValidator === "function") {
    injected.setDefaultValidator();
  } else {
    setStage("Selecting active validator...");
    await injected.setSlotValidator();
    setStage("Waiting for wallet signature...");
  }
  await injected.sign();
  const rpcData = injected._rpcData;
  if (!rpcData) {
    throw new Error("Injected watch payload is unavailable");
  }
  unsubscribe = await watchContext.provider.subscribe(
    INJECTED_WATCH_SUBSCRIBE,
    INJECTED_WATCH_UNSUBSCRIBE,
    rpcData,
    (error: unknown, result: unknown) => {
      if (error) {
        rejectPromise?.(error);
        return;
      }

      resolvePromise?.(
        new InjectedTxPromise(result as never, watchContext.ethClient as never) as unknown as InjectedPromiseResult
      );
    }
  );
  setStage("Submitting to validator...");
  await injected.send();
  const txHash = typeof injected.txHash === "string" ? injected.txHash : null;
  if (afterAccept) {
    await afterAccept(txHash);
  }
  return {
    promise: watchedPromise.finally(() => {
      unsubscribe?.();
    }),
    txHash
  };
}

async function finalizeInjectedPromise(
  promise: InjectedPromiseResult,
  _actionLabel: string
) {
  let validatorAddress: Address | null = null;
  try {
    await promise.validateSignature();
    validatorAddress = promise.validatorAddress ?? null;
  } catch {
    // Hoodi validator registration can lag behind promise signing. Keep the
    // transaction path usable as long as the program reply itself succeeded.
  }

  assertReplySuccess(promise);
  return validatorAddress;
}

function assertClassicReplySuccess(replyCode: Hex) {
  assertReplySuccess({ code: ReplyCode.fromBytes(replyCode) });
}

async function waitForMirrorStateChange(
  api: Awaited<ReturnType<typeof createVaraEthApi>>,
  destination: Address,
  previousStateHash: Hex | null,
  label: string
) {
  if (!previousStateHash) {
    return null;
  }

  const mirror = getMirrorClient({
    address: destination,
    publicClient: api.eth.publicClient
  });
  const deadlineAt = Date.now() + MIRROR_VISIBILITY_TIMEOUT_MS;

  while (Date.now() < deadlineAt) {
    try {
      const nextStateHash = await mirror.stateHash();
      if (nextStateHash !== previousStateHash) {
        return nextStateHash;
      }
    } catch (error) {
      if (!isTransientNetworkError(error)) {
        throw error;
      }
    }

    await sleep(MIRROR_VISIBILITY_POLL_MS);
  }

  return null;
}

async function readMirrorStateHashOrNull(
  api: Awaited<ReturnType<typeof createVaraEthApi>>,
  destination: Address
) {
  try {
    const mirror = getMirrorClient({
      address: destination,
      publicClient: api.eth.publicClient
    });
    return await mirror.stateHash();
  } catch (error) {
    if (isTransientNetworkError(error)) {
      return null;
    }
    throw error;
  }
}

async function refreshWithRetries(loadState: () => Promise<void>, attempts = 6) {
  let lastError: unknown;

  for (let index = 0; index < attempts; index += 1) {
    try {
      await loadState();
      return true;
    } catch (error) {
      lastError = error;
      if (!isTransientNetworkError(error)) {
        throw error;
      }
      await sleep(1_000 * (index + 1));
    }
  }

  if (lastError && !isTransientNetworkError(lastError)) {
    throw lastError;
  }

  return false;
}

export function useVaraEthProgram(
  asset: Asset,
  walletAddress: Address | null,
  liveReferencePrice: number | null = null,
  enabled = false,
  executionMode: VaraEthExecutionMode = "injected"
) {
  const marketProgramId = getVaraEthMarketProgramId(asset);
  const missingEnvKeys = useMemo(() => getMissingVaraEthProgramEnvKeys(), []);
  const programsOk = missingEnvKeys.length === 0;
  const [onchainAccount, setOnchainAccount] = useState<AccountSnapshot | null>(null);
  const [onchainMarket, setOnchainMarket] = useState<MarketSnapshot | null>(null);
  const [onchainPositions, setOnchainPositions] = useState<PositionSnapshot[]>([]);
  const [onchainPool, setOnchainPool] = useState<{ totalLiquidity: string; maxOpenNotional: string; reservedNotional: string } | null>(null);
  const [isApiReady, setIsApiReady] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [actionPreconfirmed, setActionPreconfirmed] = useState(false);
  const [actionStatusMessage, setActionStatusMessage] = useState<string | null>(null);
  const [syncPending, setSyncPending] = useState(false);
  const [syncStatusMessage, setSyncStatusMessage] = useState<string | null>(null);
  const [runtimeWarning, setRuntimeWarning] = useState<string | null>(null);
  const [lastEthereumTxHash, setLastEthereumTxHash] = useState<string | null>(null);
  const [lastReplyTxHash, setLastReplyTxHash] = useState<string | null>(null);
  const [lastInjectedTxHash, setLastInjectedTxHash] = useState<string | null>(null);
  const [lastValidatorAddress, setLastValidatorAddress] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const contextRef = useRef<{ key: string; promise: Promise<VaraEthContext> } | null>(null);
  const actionPendingRef = useRef(false);
  const actionPreconfirmedRef = useRef(false);
  const lastLoadErrorRef = useRef<string | null>(null);
  const optimisticPositionIdRef = useRef(-1);
  const syncSequenceRef = useRef(0);

  const getContext = useCallback(async () => {
    if (!enabled) {
      throw new Error("Vara.eth mode is not active");
    }
    if (!walletAddress) {
      throw new Error("Connect an EVM wallet first");
    }
    const injectedProvider = getPreferredEvmProvider();
    if (!injectedProvider) {
      throw new Error("No EVM wallet provider is available");
    }
    if (!programsOk || !marketProgramId) {
      throw new Error(`Missing Vara.eth env: ${missingEnvKeys.join(", ")}`);
    }

    const contextKey = [
      walletAddress,
      asset,
      marketProgramId,
      VARA_ETH_ETH_RPC_URL,
      VARA_ETH_VARA_RPC_URL,
      VARA_ETH_ROUTER_ADDRESS
    ].join(":");

    if (contextRef.current?.key === contextKey) {
      return contextRef.current.promise;
    }

    const promise = (async () => {
      const [marketProgram, poolProgram, tokenProgram, vaultProgram] = await Promise.all([
        createSailsProgram(perpMarketIdl),
        createSailsProgram(liquidityPoolIdl),
        createSailsProgram(demoUsdcIdl),
        createSailsProgram(marginVaultIdl)
      ]);
      const publicClient = createPublicClient({
        chain: VARA_ETH_CHAIN,
        transport: http(VARA_ETH_ETH_RPC_URL)
      });
      const walletClient = createWalletClient({
        account: walletAddress,
        chain: VARA_ETH_CHAIN,
        transport: custom(injectedProvider as Parameters<typeof custom>[0])
      });
      const signer = walletClientToSigner(walletClient);
      const api = await createVaraEthApi(
        new WsVaraEthProvider(VARA_ETH_VARA_RPC_URL),
        publicClient,
        VARA_ETH_ROUTER_ADDRESS as Address,
        signer
      );

      return {
        api,
        marketProgram,
        poolProgram,
        publicClient,
        signer,
        tokenProgram,
        vaultProgram
      };
    })().catch((error) => {
      if (contextRef.current?.key === contextKey) {
        contextRef.current = null;
      }
      throw error;
    });

    contextRef.current = { key: contextKey, promise };
    return promise;
  }, [asset, enabled, marketProgramId, missingEnvKeys, programsOk, walletAddress]);

  const refresh = useCallback(() => {
    setRefreshTick((value) => value + 1);
  }, []);

  const recordInjectedPromise = useCallback(async (promise: InjectedPromiseResult, actionLabel: string) => {
    setLastEthereumTxHash(null);
    setLastReplyTxHash(null);
    setLastInjectedTxHash(promise.txHash ?? null);
    const validatorAddress = await finalizeInjectedPromise(promise, actionLabel);
    setLastValidatorAddress(validatorAddress ?? null);
  }, []);

  const sendClassicMessage = useCallback(async (
    destination: Address,
    payload: Hex,
    setStage: (message: string) => void
  ) => {
    const { publicClient, signer } = await getContext();
    const mirror = getMirrorClient({
      address: destination,
      publicClient,
      signer
    });

    setStage("Waiting for wallet signature...");
    const txManager = await mirror.sendMessage(payload, 0n);
    const txHash = await txManager.send();
    setLastInjectedTxHash(null);
    setLastValidatorAddress(null);
    setLastEthereumTxHash(txHash);
    setLastReplyTxHash(null);
    setStage("Submitted to Hoodi. Waiting for transaction receipt...");
    const replyListener = await txManager.setupReplyListener();
    setStage("Hoodi tx mined. Waiting for Vara.eth reply...");
    const reply = await replyListener.waitForReply();
    setLastReplyTxHash(reply.txHash);
    assertClassicReplySuccess(reply.replyCode as Hex);
    return reply;
  }, [getContext]);

  const applyOptimisticMint = useCallback((amountUnits: bigint) => {
    setOnchainAccount((current) => (
      current
        ? adjustAccountSnapshot(current, { walletBalance: amountUnits })
        : current
    ));
  }, []);

  const applyOptimisticDeposit = useCallback((amountUnits: bigint) => {
    setOnchainAccount((current) => (
      current
        ? adjustAccountSnapshot(current, {
            walletBalance: -amountUnits,
            freeCollateral: amountUnits
          })
        : current
    ));
  }, []);

  const applyOptimisticWithdraw = useCallback((amountUnits: bigint) => {
    setOnchainAccount((current) => (
      current
        ? adjustAccountSnapshot(current, {
            walletBalance: amountUnits,
            freeCollateral: -amountUnits
          })
        : current
    ));
  }, []);

  const applyOptimisticLiquidity = useCallback((amountUnits: bigint) => {
    setOnchainAccount((current) => {
      if (!current) {
        return current;
      }

      return adjustAccountSnapshot(current, {
        walletBalance: -amountUnits,
        lpShares: amountUnits
      });
    });
    setOnchainPool((current) => (
      current
        ? adjustPoolSnapshot(current, { totalLiquidity: amountUnits })
        : current
    ));
  }, []);

  const applyOptimisticOpen = useCallback((
    side: "long" | "short",
    size: bigint,
    markPrice: bigint,
    margin: bigint,
    leverage: number
  ) => {
    const positionId = optimisticPositionIdRef.current;
    optimisticPositionIdRef.current -= 1;
    const trader = walletAddress ?? "wallet";

    setOnchainAccount((current) => (
      current
        ? adjustAccountSnapshot(current, {
            freeCollateral: -margin,
            lockedCollateral: margin
          })
        : current
    ));
    setOnchainPool((current) => (
      current
        ? adjustPoolSnapshot(current, {
            reservedNotional: (size * markPrice) / PRICE_SCALE / PRICE_TO_COLLATERAL_SCALE
          })
        : current
    ));
    setOnchainMarket((current) => (
      current
        ? adjustMarketSnapshot(current, side === "long"
          ? { openInterestLong: size }
          : { openInterestShort: size })
        : current
    ));
    setOnchainPositions((current) => [
      buildOptimisticPosition(positionId, trader, asset, side, size, markPrice, margin, leverage),
      ...current
    ]);
  }, [asset, walletAddress]);

  const applyOptimisticClose = useCallback((positionToClose: PositionSnapshot) => {
    const size = decimalStringToBigInt(positionToClose.size, 8);
    const margin = decimalStringToBigInt(positionToClose.margin, 6);
    const notional = decimalStringToBigInt(positionToClose.notional, 6);
    const entryPrice = decimalStringToBigInt(positionToClose.entryPrice, 8);
    const markPrice = decimalStringToBigInt(positionToClose.markPrice, 8);
    const signedSize = positionToClose.side === "long" ? size : -size;
    const pnl = ((markPrice - entryPrice) * signedSize) / PRICE_SCALE / PRICE_TO_COLLATERAL_SCALE;
    const payout = (margin + pnl) > 0n ? (margin + pnl) : 0n;

    setOnchainAccount((current) => (
      current
        ? adjustAccountSnapshot(current, {
            freeCollateral: payout,
            lockedCollateral: -margin
          })
        : current
    ));
    setOnchainPool((current) => (
      current
        ? adjustPoolSnapshot(current, { reservedNotional: -notional })
        : current
    ));
    setOnchainMarket((current) => (
      current
        ? adjustMarketSnapshot(current, positionToClose.side === "long"
          ? { openInterestLong: -size }
          : { openInterestShort: -size })
        : current
    ));
    setOnchainPositions((current) => current.filter((position) => position.id !== positionToClose.id));
  }, []);

  const loadState = useCallback(async () => {
    if (!enabled || !walletAddress || !programsOk || !marketProgramId) {
      setOnchainAccount(null);
      setOnchainMarket(null);
      setOnchainPositions([]);
      setOnchainPool(null);
      setRuntimeWarning(null);
      setIsApiReady(false);
      return;
    }

    const { api, marketProgram, poolProgram, tokenProgram, vaultProgram } = await getContext();
    const sourceActorId = evmAddressToActorId(walletAddress);
    const marketService = marketProgram.services.Market;
    const poolService = poolProgram.services.Pool;
    const tokenService = tokenProgram.services.Token;
    const vaultService = vaultProgram.services.Vault;
    if (!marketService || !poolService || !tokenService || !vaultService) {
      throw new Error("Required Vara.eth Sails services are unavailable");
    }
    const marketStateQuery = marketService.queries.MarketState;
    const vaultAccountQuery = vaultService.queries.Account;
    const positionsQuery = marketService.queries.Positions;
    const balanceOfQuery = tokenService.queries.BalanceOf;
    const lpAccountQuery = poolService.queries.Account;
    const poolStateQuery = poolService.queries.PoolState;
    if (!marketStateQuery || !vaultAccountQuery || !positionsQuery || !balanceOfQuery || !lpAccountQuery || !poolStateQuery) {
      throw new Error("Required Vara.eth query surfaces are unavailable");
    }

    const runQuery = async <T>(destination: Address, query: { encodePayload: (...args: unknown[]) => Hex; decodeResult: (payload: Hex) => T }, ...args: unknown[]) => {
      const payload = query.encodePayload(...args);
      const reply = await api.call.program.calculateReplyForHandle(walletAddress, destination, payload);
      assertReplySuccess(reply);
      return query.decodeResult(reply.payload);
    };

    const [
      marketResult,
      vaultAccountResult,
      positionsResult,
      walletBalanceResult,
      lpAccountResult,
      poolStateResult
    ] = await Promise.allSettled([
      runQuery<VaraMarketSnapshot>(marketProgramId as Address, marketStateQuery),
      runQuery<VaraAccountSnapshot>(VARA_ETH_MARGIN_VAULT_PROGRAM_ID as Address, vaultAccountQuery, sourceActorId),
      runQuery<VaraOpenPositionSnapshot[]>(marketProgramId as Address, positionsQuery, sourceActorId),
      runQuery<bigint>(VARA_ETH_DEMO_USDC_PROGRAM_ID as Address, balanceOfQuery, sourceActorId),
      runQuery<VaraLpAccount>(VARA_ETH_LIQUIDITY_POOL_PROGRAM_ID as Address, lpAccountQuery, sourceActorId),
      runQuery<VaraPoolState>(VARA_ETH_LIQUIDITY_POOL_PROGRAM_ID as Address, poolStateQuery)
    ]);

    if (vaultAccountResult.status !== "fulfilled") {
      throw vaultAccountResult.reason;
    }
    if (walletBalanceResult.status !== "fulfilled") {
      throw walletBalanceResult.reason;
    }
    if (lpAccountResult.status !== "fulfilled") {
      throw lpAccountResult.reason;
    }
    if (poolStateResult.status !== "fulfilled") {
      throw poolStateResult.reason;
    }

    const market = marketResult.status === "fulfilled" ? marketResult.value : null;
    const positions = positionsResult.status === "fulfilled" ? positionsResult.value : [];
    const vaultAccount = vaultAccountResult.value;
    const walletBalance = walletBalanceResult.value;
    const lpAccount = lpAccountResult.value;
    const poolState = poolStateResult.value;
    const warnings: string[] = [];
    if (marketResult.status !== "fulfilled" && !isQueryOutOfGasError(marketResult.reason)) {
      warnings.push("MarketState read is unavailable on the current Hoodi deployment.");
    }
    if (positionsResult.status !== "fulfilled" && !isQueryOutOfGasError(positionsResult.reason)) {
      warnings.push("Positions read is unavailable on the current Hoodi deployment.");
    }

    setOnchainMarket(market ? parseMarket(asset, market) : null);
    setOnchainAccount(parseTraderAccount(vaultAccount, walletBalance, lpAccount.shares));
    setOnchainPositions(
      positions.map((position) => parsePosition(
        asset,
        market ?? {
          mark_price: 0n,
          index_price: 0n,
          funding_rate_bps: 0n,
          cumulative_funding_rate_bps: 0n,
          open_interest_long: 0n,
          open_interest_short: 0n
        },
        position,
        null
      ))
    );
    setOnchainPool(parsePoolState(poolState));
    setRuntimeWarning(warnings.length > 0 ? warnings.join(" ") : null);
    if (lastLoadErrorRef.current) {
      lastLoadErrorRef.current = null;
      setActionStatusMessage(null);
    }
    setIsApiReady(true);
  }, [asset, enabled, getContext, marketProgramId, programsOk, walletAddress]);

  const refreshAfterRealWrite = useCallback(async (
    successMessage: string,
    fallbackMessage: string,
    helpers: Pick<VaraEthActionHelpers, "setPreconfirmed" | "startBackgroundSync">
  ) => {
    helpers.setPreconfirmed(successMessage);
    const refreshed = await refreshWithRetries(loadState, 3);
    if (refreshed) {
      refresh();
      return;
    }

    helpers.startBackgroundSync(fallbackMessage, async () => {
      await refreshWithRetries(loadState);
      refresh();
    });
  }, [loadState, refresh]);

  const runAction = useCallback(
    async <T>(
      pendingMessage: string,
      execute: (helpers: VaraEthActionHelpers) => Promise<T>
    ) => {
      if (actionPendingRef.current) {
        throw new Error("Another Vara.eth transaction is already pending.");
      }

      actionPendingRef.current = true;
      actionPreconfirmedRef.current = false;
      setActionPending(true);
      setActionPreconfirmed(false);
      setActionStatusMessage(pendingMessage);
      setSyncPending(false);
      setSyncStatusMessage(null);
      setLastEthereumTxHash(null);
      setLastReplyTxHash(null);
      setLastInjectedTxHash(null);
      setLastValidatorAddress(null);
      let optimisticSnapshot: OptimisticSnapshot | undefined;
      let shouldClearActionMessage = true;
      const setStage = (message: string) => {
        setActionStatusMessage(message);
      };
      const setPreconfirmed = (message: string) => {
        actionPreconfirmedRef.current = true;
        setActionPreconfirmed(true);
        setActionStatusMessage(message);
      };
      const setSubmitted = (message: string, applyOptimistic?: () => void) => {
        if (!optimisticSnapshot) {
          optimisticSnapshot = {
            account: onchainAccount,
            market: onchainMarket,
            positions: onchainPositions,
            pool: onchainPool
          };
        }
        if (applyOptimistic) {
          applyOptimistic();
        }
        setActionStatusMessage(message);
      };
      const setSyncing = (message: string) => {
        setActionStatusMessage(message);
      };
      const startBackgroundSync = (message: string, task: () => Promise<void>) => {
        const syncId = syncSequenceRef.current + 1;
        syncSequenceRef.current = syncId;
        setSyncPending(true);
        setSyncStatusMessage(message);

        void (async () => {
          try {
            await task();
            if (syncSequenceRef.current === syncId) {
              setSyncPending(false);
              setSyncStatusMessage(null);
            }
          } catch (error) {
            if (syncSequenceRef.current !== syncId) {
              return;
            }
            setActionPreconfirmed(false);
            setSyncPending(false);
            setSyncStatusMessage(describeError(error));
          }
        })();
      };

      try {
        const result = await execute({ setPreconfirmed, setSubmitted, startBackgroundSync, setSyncing, setStage });
        if (!actionPreconfirmedRef.current) {
          setSyncing("Refreshing visible Vara.eth state...");
          const refreshed = await refreshWithRetries(loadState);
          refresh();
          if (!refreshed) {
            setSyncStatusMessage("Transaction succeeded, but mirror state is still catching up.");
            window.setTimeout(() => {
              void loadState().catch(() => undefined);
            }, 3_000);
          }
        }
        return result;
      } catch (error) {
        const snapshotToRestore: OptimisticSnapshot | undefined = optimisticSnapshot;
        if (snapshotToRestore) {
          setOnchainAccount(snapshotToRestore.account);
          setOnchainMarket(snapshotToRestore.market);
          setOnchainPositions(snapshotToRestore.positions);
          setOnchainPool(snapshotToRestore.pool);
        }
        shouldClearActionMessage = false;
        setSyncPending(false);
        setSyncStatusMessage(null);
        setActionStatusMessage(describeError(error));
        throw error;
      } finally {
        actionPendingRef.current = false;
        actionPreconfirmedRef.current = false;
        setActionPending(false);
        if (shouldClearActionMessage) {
          setActionStatusMessage(null);
        }
      }
    },
    [loadState, onchainAccount, onchainMarket, onchainPool, onchainPositions, refresh]
  );

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | null = null;

    void loadState().catch((error) => {
      if (cancelled) {
        return;
      }

      setIsApiReady(false);
      setOnchainAccount(null);
      setOnchainMarket(null);
      setOnchainPositions([]);
      setOnchainPool(null);
      const message = describeError(error);
      if (lastLoadErrorRef.current !== message) {
        lastLoadErrorRef.current = message;
        setActionStatusMessage(message);
      }

      if (isTransientNetworkError(error)) {
        retryTimer = window.setTimeout(() => {
          if (!cancelled) {
            refresh();
          }
        }, 1_500);
      }
    });

    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [loadState, refresh, refreshTick]);

  return useMemo(
    () => ({
      asset,
      isApiReady,
      isVaraEthReady: enabled && programsOk && Boolean(walletAddress) && Boolean(marketProgramId),
      onchainAccount,
      onchainMarket,
      onchainPositions,
      onchainPool,
      onchainSession: null,
      localSessionSigner: null,
      hasSessionSigner: false,
      signlessModeEnabled: false,
      signlessEnabled: false,
      gaslessEnabled: false,
      actionPending,
      actionPreconfirmed,
      actionStatusMessage,
      runtimeWarning,
      lastEthereumTxHash,
      lastReplyTxHash,
      lastInjectedTxHash,
      lastInjectedTxTrackerUrl: buildInjectedTxTrackerUrl(lastInjectedTxHash),
      lastValidatorAddress,
      syncPending,
      syncStatusMessage,
      async fundWalletGas() {
        throw new Error("Vara.eth uses your connected EVM wallet for gas. Fund that wallet with native gas on the selected chain.");
      },
      async createSession() {
        throw new Error("Vara.eth mode uses direct wallet-signed injected messages. Session registration is only available on the Vara extension path.");
      },
      async revokeSession() {
        throw new Error("No Vara session is active in Vara.eth mode.");
      },
      async mintDemoTokens(amount: number) {
        return runAction("Confirm mint in your wallet...", async ({ setPreconfirmed, startBackgroundSync, setStage }) => {
          const { api, tokenProgram } = await getContext();
          const tokenService = tokenProgram.services.Token;
          const mint = tokenService?.functions.Mint;
          if (!mint) {
            throw new Error("Token mint function is unavailable");
          }

          const payload = mint.encodePayload(decimalToBigInt(amount, 6));
          if (executionMode === "injected") {
            const injected = await api.createInjectedTransaction({
              destination: VARA_ETH_DEMO_USDC_PROGRAM_ID as Address,
              payload,
              value: 0n
            });
            const { promise } = await sendInjectedWithStages(
              injected,
              { provider: api.provider, ethClient: api.eth },
              setStage,
              (acceptedTxHash) => {
                setLastInjectedTxHash(acceptedTxHash);
                setPreconfirmed("Accepted by validator. Waiting for signed Vara.eth promise...");
              }
            );
            startBackgroundSync("Accepted by validator. Waiting for signed Vara.eth promise...", async () => {
              const resolved = await promise;
              await recordInjectedPromise(resolved, "mint");
              setActionPreconfirmed(true);
              setSyncStatusMessage("Mint pre-confirmed on Vara.eth. Refreshing live state...");
              const refreshed = await refreshWithRetries(loadState, 3);
              if (!refreshed) {
                setSyncStatusMessage("Mint pre-confirmed on Vara.eth. Syncing live token balance...");
                await refreshWithRetries(loadState);
              }
              refresh();
            });
            return;
          }

          await sendClassicMessage(
            VARA_ETH_DEMO_USDC_PROGRAM_ID as Address,
            payload,
            setStage
          );
          setStage("Mint reply confirmed. Refreshing live state...");
        });
      },
      async deposit(amount: number) {
        return runAction("Confirm deposit in your wallet...", async ({ setPreconfirmed, startBackgroundSync, setStage }) => {
          if (!walletAddress) {
            throw new Error("Connect an EVM wallet first");
          }

          const { api, tokenProgram, vaultProgram } = await getContext();
          const tokenService = tokenProgram.services.Token;
          const vaultService = vaultProgram.services.Vault;
          const approve = tokenService?.functions.Approve;
          const allowanceQuery = tokenService?.queries.Allowance;
          const balanceOfQuery = tokenService?.queries.BalanceOf;
          const deposit = vaultService?.functions.Deposit;
          if (!approve || !allowanceQuery || !balanceOfQuery || !deposit) {
            throw new Error("Required token or vault functions are unavailable");
          }

          const ownerActorId = evmAddressToActorId(walletAddress);
          const vaultActorId = evmAddressToActorId(VARA_ETH_MARGIN_VAULT_PROGRAM_ID as Address);
          const amountUnits = decimalToBigInt(amount, 6);
          const readQuery = async <T>(destination: Address, query: { encodePayload: (...args: unknown[]) => Hex; decodeResult: (payload: Hex) => T }, ...args: unknown[]) => {
            const payload = query.encodePayload(...args);
            const reply = await api.call.program.calculateReplyForHandle(walletAddress, destination, payload);
            assertReplySuccess(reply);
            return query.decodeResult(reply.payload);
          };

          const walletBalance = toBigInt(
            await readQuery<bigint>(VARA_ETH_DEMO_USDC_PROGRAM_ID as Address, balanceOfQuery, ownerActorId)
          );
          if (walletBalance < amountUnits) {
            throw new Error(
              `Wallet balance is only ${formatUnits(walletBalance, 6)} tUSDC, but deposit needs ${formatUnits(amountUnits, 6)} tUSDC.`
            );
          }

          const allowance = toBigInt(
            await readQuery<bigint>(VARA_ETH_DEMO_USDC_PROGRAM_ID as Address, allowanceQuery, ownerActorId, vaultActorId)
          );
          if (allowance < amountUnits) {
            if (executionMode === "injected") {
              const approveInjected = await api.createInjectedTransaction({
                destination: VARA_ETH_DEMO_USDC_PROGRAM_ID as Address,
                payload: approve.encodePayload(vaultActorId, MAX_U128),
                value: 0n
              });
              const { promise: approvePromise } = await sendInjectedWithStages(
                approveInjected,
                { provider: api.provider, ethClient: api.eth },
                setStage,
                () => {
                  setStage("Approval accepted by validator. Waiting for signed promise...");
                }
              );
              await recordInjectedPromise(await approvePromise, "deposit approval");
            } else {
              await sendClassicMessage(
                VARA_ETH_DEMO_USDC_PROGRAM_ID as Address,
                approve.encodePayload(vaultActorId, MAX_U128),
                setStage
              );
            }
            setStage("Waiting for token allowance to appear...");
            const nextAllowance = await waitForValue(
              () => readQuery<bigint>(VARA_ETH_DEMO_USDC_PROGRAM_ID as Address, allowanceQuery, ownerActorId, vaultActorId),
              (value) => toBigInt(value) >= amountUnits
            );
            if (toBigInt(nextAllowance ?? 0n) < amountUnits) {
              throw new Error("Token allowance did not update after approval.");
            }
          }

          if (executionMode === "injected") {
            const depositInjected = await api.createInjectedTransaction({
              destination: VARA_ETH_MARGIN_VAULT_PROGRAM_ID as Address,
              payload: deposit.encodePayload(amountUnits),
              value: 0n
            });
            const { promise: depositPromise } = await sendInjectedWithStages(
              depositInjected,
              { provider: api.provider, ethClient: api.eth },
              setStage,
              (acceptedTxHash) => {
                setLastInjectedTxHash(acceptedTxHash);
                setPreconfirmed("Deposit accepted by validator. Waiting for signed Vara.eth promise...");
              }
            );
            startBackgroundSync("Accepted by validator. Waiting for signed Vara.eth promise...", async () => {
              const resolved = await depositPromise;
              await recordInjectedPromise(resolved, "deposit");
              setActionPreconfirmed(true);
              setSyncStatusMessage("Deposit pre-confirmed on Vara.eth. Refreshing live state...");
              const refreshed = await refreshWithRetries(loadState, 3);
              if (!refreshed) {
                setSyncStatusMessage("Deposit pre-confirmed on Vara.eth. Syncing live vault balance...");
                await refreshWithRetries(loadState);
              }
              refresh();
            });
            return;
          }

          await sendClassicMessage(
            VARA_ETH_MARGIN_VAULT_PROGRAM_ID as Address,
            deposit.encodePayload(amountUnits),
            setStage
          );
          setStage("Deposit reply confirmed. Refreshing live state...");
        });
      },
      async provideDemoLiquidity(amount: number) {
        return runAction("Confirm LP funding in your wallet...", async ({ setPreconfirmed, startBackgroundSync, setStage }) => {
          if (!walletAddress) {
            throw new Error("Connect an EVM wallet first");
          }

          const { api, tokenProgram, poolProgram } = await getContext();
          const tokenService = tokenProgram.services.Token;
          const poolService = poolProgram.services.Pool;
          const approve = tokenService?.functions.Approve;
          const allowanceQuery = tokenService?.queries.Allowance;
          const balanceOfQuery = tokenService?.queries.BalanceOf;
          const depositLiquidity = poolService?.functions.DepositLiquidity;
          if (!approve || !allowanceQuery || !balanceOfQuery || !depositLiquidity) {
            throw new Error("Required token or pool functions are unavailable");
          }

          const ownerActorId = evmAddressToActorId(walletAddress);
          const poolActorId = evmAddressToActorId(VARA_ETH_LIQUIDITY_POOL_PROGRAM_ID as Address);
          const amountUnits = decimalToBigInt(amount, 6);
          const readQuery = async <T>(destination: Address, query: { encodePayload: (...args: unknown[]) => Hex; decodeResult: (payload: Hex) => T }, ...args: unknown[]) => {
            const payload = query.encodePayload(...args);
            const reply = await api.call.program.calculateReplyForHandle(walletAddress, destination, payload);
            assertReplySuccess(reply);
            return query.decodeResult(reply.payload);
          };

          const walletBalance = toBigInt(
            await readQuery<bigint>(VARA_ETH_DEMO_USDC_PROGRAM_ID as Address, balanceOfQuery, ownerActorId)
          );
          if (walletBalance < amountUnits) {
            throw new Error(
              `Wallet balance is only ${formatUnits(walletBalance, 6)} tUSDC, but LP funding needs ${formatUnits(amountUnits, 6)} tUSDC.`
            );
          }

          const allowance = toBigInt(
            await readQuery<bigint>(VARA_ETH_DEMO_USDC_PROGRAM_ID as Address, allowanceQuery, ownerActorId, poolActorId)
          );
          if (allowance < amountUnits) {
            if (executionMode === "injected") {
              const approveInjected = await api.createInjectedTransaction({
                destination: VARA_ETH_DEMO_USDC_PROGRAM_ID as Address,
                payload: approve.encodePayload(poolActorId, MAX_U128),
                value: 0n
              });
              const { promise: approvePromise } = await sendInjectedWithStages(
                approveInjected,
                { provider: api.provider, ethClient: api.eth },
                setStage,
                () => {
                  setStage("LP approval accepted by validator. Waiting for signed promise...");
                }
              );
              await recordInjectedPromise(await approvePromise, "liquidity approval");
            } else {
              await sendClassicMessage(
                VARA_ETH_DEMO_USDC_PROGRAM_ID as Address,
                approve.encodePayload(poolActorId, MAX_U128),
                setStage
              );
            }
            setStage("Waiting for LP token allowance to appear...");
            const nextAllowance = await waitForValue(
              () => readQuery<bigint>(VARA_ETH_DEMO_USDC_PROGRAM_ID as Address, allowanceQuery, ownerActorId, poolActorId),
              (value) => toBigInt(value) >= amountUnits
            );
            if (toBigInt(nextAllowance ?? 0n) < amountUnits) {
              throw new Error("LP token allowance did not update after approval.");
            }
          }

          if (executionMode === "injected") {
            const liquidityInjected = await api.createInjectedTransaction({
              destination: VARA_ETH_LIQUIDITY_POOL_PROGRAM_ID as Address,
              payload: depositLiquidity.encodePayload(amountUnits),
              value: 0n
            });
            const { promise: liquidityPromise } = await sendInjectedWithStages(
              liquidityInjected,
              { provider: api.provider, ethClient: api.eth },
              setStage,
              (acceptedTxHash) => {
                setLastInjectedTxHash(acceptedTxHash);
                setPreconfirmed("LP deposit accepted by validator. Waiting for signed Vara.eth promise...");
              }
            );
            startBackgroundSync("Accepted by validator. Waiting for signed Vara.eth promise...", async () => {
              const resolved = await liquidityPromise;
              await recordInjectedPromise(resolved, "liquidity deposit");
              setActionPreconfirmed(true);
              setSyncStatusMessage("LP deposit pre-confirmed on Vara.eth. Refreshing live state...");
              const refreshed = await refreshWithRetries(loadState, 3);
              if (!refreshed) {
                setSyncStatusMessage("LP deposit pre-confirmed on Vara.eth. Syncing live pool state...");
                await refreshWithRetries(loadState);
              }
              refresh();
            });
            return;
          }

          await sendClassicMessage(
            VARA_ETH_LIQUIDITY_POOL_PROGRAM_ID as Address,
            depositLiquidity.encodePayload(amountUnits),
            setStage
          );
          setStage("LP deposit reply confirmed. Refreshing live state...");
        });
      },
      async withdraw(amount: number) {
        return runAction("Confirm withdraw in your wallet...", async ({ setPreconfirmed, startBackgroundSync, setStage }) => {
          const { api, vaultProgram } = await getContext();
          const withdraw = vaultProgram.services.Vault?.functions.Withdraw;
          if (!withdraw) {
            throw new Error("Vault withdraw function is unavailable");
          }

          const amountUnits = decimalToBigInt(amount, 6);
          if (executionMode === "injected") {
            const injected = await api.createInjectedTransaction({
              destination: VARA_ETH_MARGIN_VAULT_PROGRAM_ID as Address,
              payload: withdraw.encodePayload(amountUnits),
              value: 0n
            });
            const { promise } = await sendInjectedWithStages(
              injected,
              { provider: api.provider, ethClient: api.eth },
              setStage,
              (acceptedTxHash) => {
                setLastInjectedTxHash(acceptedTxHash);
                setPreconfirmed("Withdraw accepted by validator. Waiting for signed Vara.eth promise...");
              }
            );
            startBackgroundSync("Accepted by validator. Waiting for signed Vara.eth promise...", async () => {
              const resolved = await promise;
              await recordInjectedPromise(resolved, "withdraw");
              setActionPreconfirmed(true);
              setSyncStatusMessage("Withdraw pre-confirmed on Vara.eth. Refreshing live state...");
              const refreshed = await refreshWithRetries(loadState, 3);
              if (!refreshed) {
                setSyncStatusMessage("Withdraw pre-confirmed on Vara.eth. Syncing live vault state...");
                await refreshWithRetries(loadState);
              }
              refresh();
            });
            return;
          }

          await sendClassicMessage(
            VARA_ETH_MARGIN_VAULT_PROGRAM_ID as Address,
            withdraw.encodePayload(amountUnits),
            setStage
          );
          setStage("Withdraw reply confirmed. Refreshing live state...");
        });
      },
      async openPosition(input: PositionInput) {
        return runAction(`Confirm ${input.side} trade in your wallet...`, async ({ setPreconfirmed, startBackgroundSync, setStage }) => {
          if (!walletAddress) {
            throw new Error("Connect an EVM wallet first");
          }

          const { api, marketProgram, poolProgram, vaultProgram } = await getContext();
          const marketService = marketProgram.services.Market;
          const poolService = poolProgram.services.Pool;
          const vaultService = vaultProgram.services.Vault;
          const openPosition = marketService?.functions.OpenPosition;
          const positionsQuery = marketService?.queries.Positions;
          const marketStateQuery = marketService?.queries.MarketState;
          const poolStateQuery = poolService?.queries.PoolState;
          const vaultAccountQuery = vaultService?.queries.Account;
          if (!openPosition || !positionsQuery) {
            throw new Error("Market trading functions are unavailable");
          }
          if (!marketStateQuery || !poolStateQuery || !vaultAccountQuery) {
            throw new Error("Trade preflight queries are unavailable");
          }

          const existingNetPosition = onchainPositions.find((position) => position.asset === asset) ?? null;
          const sourceActorId = evmAddressToActorId(walletAddress);
          const runQuery = async <T>(destination: Address, query: { encodePayload: (...args: unknown[]) => Hex; decodeResult: (payload: Hex) => T }, ...args: unknown[]) => {
            const payload = query.encodePayload(...args);
            const reply = await api.call.program.calculateReplyForHandle(walletAddress, destination, payload);
            assertReplySuccess(reply);
            return query.decodeResult(reply.payload);
          };
          const [marketStateResult, poolState, vaultAccount] = await Promise.all([
            runQuery<VaraMarketSnapshot>(marketProgramId as Address, marketStateQuery).catch((error) => {
              if (isQueryOutOfGasError(error)) {
                return null;
              }
              throw error;
            }),
            runQuery<VaraPoolState>(VARA_ETH_LIQUIDITY_POOL_PROGRAM_ID as Address, poolStateQuery),
            runQuery<VaraAccountSnapshot>(VARA_ETH_MARGIN_VAULT_PROGRAM_ID as Address, vaultAccountQuery, sourceActorId)
          ]);
          const notional = decimalToBigInt(input.notional, 6);
          const fallbackPrice = liveReferencePrice ?? (onchainMarket ? Number(onchainMarket.markPrice) : null);
          const markPrice = marketStateResult
            ? toBigInt(marketStateResult.mark_price)
            : fallbackPrice && fallbackPrice > 0
              ? decimalToBigInt(fallbackPrice, 8)
              : 0n;
          if (markPrice === 0n) {
            throw new Error("Market price is unavailable");
          }
          if (!marketStateResult) {
            setStage("MarketState query is unavailable on Hoodi. Using live terminal price for trade sizing...");
          }

          const size = (notional * SIZE_FROM_NOTIONAL_SCALE) / markPrice;
          const actualNotional = (size * markPrice) / PRICE_SCALE / PRICE_TO_COLLATERAL_SCALE;
          const margin = divCeil(actualNotional, BigInt(input.leverage)) + 1n;
          const isOppositeSideOrder = Boolean(existingNetPosition && existingNetPosition.side !== input.side);
          const existingNotional = existingNetPosition
            ? decimalStringToBigInt(existingNetPosition.notional, 6)
            : 0n;
          const incrementalNotional = isOppositeSideOrder
            ? actualNotional > existingNotional
              ? actualNotional - existingNotional
              : 0n
            : actualNotional;
          const incrementalMargin = incrementalNotional > 0n
            ? divCeil(incrementalNotional, BigInt(input.leverage)) + 1n
            : 0n;
          const freeCollateral = toBigInt(vaultAccount.free);
          if (freeCollateral < incrementalMargin) {
            throw new Error(
              `On-chain free collateral is ${formatUnits(freeCollateral, 6)} USDC, but this trade needs ${formatUnits(incrementalMargin, 6)} USDC. If you just deposited, wait for sync to finish and try again.`
            );
          }
          const liveAvailableNotional = toBigInt(poolState.max_capacity) - toBigInt(poolState.reserved_notional);
          if (liveAvailableNotional < incrementalNotional) {
            throw new Error(
              `On-chain pool capacity is only ${formatUnits(liveAvailableNotional, 6)} USDC, but this trade needs ${formatUnits(incrementalNotional, 6)} USDC.`
            );
          }
          const side = input.side === "long" ? "Long" : "Short";
          if (executionMode === "injected") {
            const injected = await api.createInjectedTransaction({
              destination: marketProgramId as Address,
              payload: openPosition.encodePayload(side, size, input.leverage, margin, input.maxSlippageBps),
              value: 0n
            });
            const { promise } = await sendInjectedWithStages(
              injected,
              { provider: api.provider, ethClient: api.eth },
              setStage,
              (acceptedTxHash) => {
                setLastInjectedTxHash(acceptedTxHash);
                setPreconfirmed("Trade accepted by validator. Waiting for signed Vara.eth promise...");
              }
            );
            startBackgroundSync("Accepted by validator. Waiting for signed Vara.eth promise...", async () => {
              const resolved = await promise;
              await recordInjectedPromise(resolved, "open position");
              setActionPreconfirmed(true);
              setSyncStatusMessage("Trade pre-confirmed on Vara.eth. Refreshing live state...");
              const refreshed = await refreshWithRetries(loadState, 3);
              if (!refreshed) {
                setSyncStatusMessage("Trade pre-confirmed on Vara.eth. Syncing live market state...");
                await refreshWithRetries(loadState);
              }
              refresh();
            });
          } else {
            await sendClassicMessage(
              marketProgramId as Address,
              openPosition.encodePayload(side, size, input.leverage, margin, input.maxSlippageBps),
              setStage
            );
            setStage("Trade reply confirmed. Refreshing live state...");
          }

          const actorId = evmAddressToActorId(walletAddress);
          try {
            const positionsReply = await api.call.program.calculateReplyForHandle(
              walletAddress,
              marketProgramId as Address,
              positionsQuery.encodePayload(actorId)
            );
            assertReplySuccess(positionsReply);
            const latestPositions = positionsQuery.decodeResult(positionsReply.payload) as VaraOpenPositionSnapshot[];
            latestPositions
              .map((position) => Number(toBigInt(position.id)))
              .forEach((positionId) => deletePositionDisplayOverride(walletAddress, asset, positionId));
          } catch (error) {
            if (!isTransientNetworkError(error) && !isQueryOutOfGasError(error)) {
              throw error;
            }
          }
        });
      },
      async closePosition(positionToClose: PositionSnapshot) {
        return runAction("Confirm close in your wallet...", async ({ setPreconfirmed, startBackgroundSync, setStage }) => {
          if (!walletAddress) {
            throw new Error("Connect an EVM wallet first");
          }
          if (positionToClose.asset !== asset) {
            throw new Error(`Switch to the ${positionToClose.asset} market tab before closing this position.`);
          }

          const { api, marketProgram } = await getContext();
          const closePosition = marketProgram.services.Market?.functions.ClosePosition;
          if (!closePosition) {
            throw new Error("Close position function is unavailable");
          }

          if (executionMode === "injected") {
            const injected = await api.createInjectedTransaction({
              destination: marketProgramId as Address,
              payload: closePosition.encodePayload(positionToClose.id, decimalToBigInt(Number(positionToClose.size), 8)),
              value: 0n
            });
            const { promise } = await sendInjectedWithStages(
              injected,
              { provider: api.provider, ethClient: api.eth },
              setStage,
              (acceptedTxHash) => {
                setLastInjectedTxHash(acceptedTxHash);
                setPreconfirmed("Close accepted by validator. Waiting for signed Vara.eth promise...");
              }
            );
            startBackgroundSync("Accepted by validator. Waiting for signed Vara.eth promise...", async () => {
              const resolved = await promise;
              await recordInjectedPromise(resolved, "close position");
              setActionPreconfirmed(true);
              setSyncStatusMessage("Close pre-confirmed on Vara.eth. Refreshing live state...");
              const refreshed = await refreshWithRetries(loadState, 3);
              if (!refreshed) {
                setSyncStatusMessage("Close pre-confirmed on Vara.eth. Syncing live market state...");
                await refreshWithRetries(loadState);
              }
              refresh();
            });
          } else {
            await sendClassicMessage(
              marketProgramId as Address,
              closePosition.encodePayload(positionToClose.id, decimalToBigInt(Number(positionToClose.size), 8)),
              setStage
            );
            setStage("Close reply confirmed. Refreshing live state...");
          }
          deletePositionDisplayOverride(walletAddress, asset, positionToClose.id);
        });
      }
    }),
    [actionPending, actionPreconfirmed, actionStatusMessage, asset, enabled, executionMode, getContext, isApiReady, lastEthereumTxHash, lastInjectedTxHash, lastReplyTxHash, lastValidatorAddress, liveReferencePrice, marketProgramId, onchainAccount, onchainMarket, onchainPool, onchainPositions, programsOk, recordInjectedPromise, refreshAfterRealWrite, runAction, runtimeWarning, sendClassicMessage, walletAddress]
  );
}
