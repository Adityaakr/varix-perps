import { useAccount, useAlert, useApi, useSails } from "@gear-js/react-hooks";
import type { HexString } from "@gear-js/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import demoUsdcIdl from "../idl/demo-usdc-vft.idl?raw";
import liquidityPoolIdl from "../idl/liquidity-pool.idl?raw";
import marginVaultIdl from "../idl/margin-vault.idl?raw";
import oracleServiceIdl from "../idl/oracle-service.idl?raw";
import perpMarketIdl from "../idl/perp-market.idl?raw";
import sessionRegistryIdl from "../idl/session-registry.idl?raw";
import {
  INDEXER_HTTP_URL,
  VARA_DEMO_USDC_PROGRAM_ID,
  VARA_LIQUIDITY_POOL_PROGRAM_ID,
  VARA_MARKET_PROGRAM_IDS,
  VARA_MARGIN_VAULT_PROGRAM_ID,
  VARA_ORACLE_SERVICE_PROGRAM_ID,
  VARA_RPC_URL,
  VARA_SESSION_DURATION_BLOCKS,
  VARA_SESSION_FUNDING_AMOUNT,
  VARA_SESSION_REGISTRY_PROGRAM_ID,
  VARA_VOUCHER_SPONSOR_URL,
  getMarketProgramId
} from "../lib/config";
import { clearSessionSigner, getOrCreateSessionSigner, loadSessionSigner } from "../lib/sessionAccount";
import type {
  Asset,
  AccountSnapshot,
  EngineSnapshot,
  LocalSessionSigner,
  MarketSnapshot,
  PositionSnapshot,
  RuntimeMode,
  SessionSnapshot,
  VaraAccountSnapshot,
  VaraLpAccount,
  VaraMarketSnapshot,
  VaraOpenPositionSnapshot,
  VaraPoolState,
  VaraSponsoredVoucherBundle,
  VaraSessionPermissions,
  VaraSessionRecord
} from "../types";

const ZERO_ACTOR = `0x${"0".repeat(64)}`;
const PRICE_SCALE = 100_000_000n;
const PRICE_TO_COLLATERAL_SCALE = 100n;
const SIZE_FROM_NOTIONAL_SCALE = PRICE_SCALE * PRICE_TO_COLLATERAL_SCALE;
const MAX_U128 = (1n << 128n) - 1n;
const TRADE_GAS_LIMIT = 750_000_000_000n;
const SESSION_GAS_FUNDING_FALLBACK = 5_000_000_000_000n;
const SESSION_MIN_NATIVE_BALANCE = 1_000_000_000_000n;
const POSITION_OVERRIDE_STORAGE_PREFIX = "varix:position-display-overrides:";

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

function divCeil(value: bigint, divisor: bigint) {
  return (value + divisor - 1n) / divisor;
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

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${INDEXER_HTTP_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({ error: "request failed" }))) as { error?: string };
    throw new Error(payload.error ?? `request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function parseSession(record: VaraSessionRecord | null) {
  if (!record) {
    return null;
  }

  return {
    owner: record.owner,
    sessionKey: record.session_key,
    expiresAt: record.expires_at,
    registeredAt: record.registered_at,
    permissions: record.permissions
  };
}

function parseVar(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return 0n;
  }
  const [wholePart, fractionalPart = ""] = trimmed.split(".");
  const normalizedWhole = wholePart || "0";
  const normalizedFraction = `${fractionalPart}000000000000`.slice(0, 12);
  return BigInt(normalizedWhole) * 10n ** 12n + BigInt(normalizedFraction);
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

function readDisplayEntryOverride(owner: string, asset: Asset, positionId: number) {
  const override = readPositionDisplayOverrides(owner)[positionOverrideKey(asset, positionId)];
  if (!override) {
    return null;
  }
  const value = Number(override.entryPrice);
  return Number.isFinite(value) && value > 0 ? decimalToBigInt(value, 8) : null;
}

function describeError(error: unknown) {
  const feeMessage = "Your wallet has tUSDC, but not enough native VARA for gas. Fund the wallet gas first.";
  if (error instanceof Error) {
    return error.message.includes("1010: Invalid Transaction: Inability to pay some fees")
      ? feeMessage
      : error.message;
  }
  if (typeof error === "string") return error;
  try {
    const serialized = JSON.stringify(error);
    return serialized.includes("1010: Invalid Transaction: Inability to pay some fees")
      ? feeMessage
      : serialized;
  } catch {
    return "Unknown error";
  }
}

const isLocalNode =
  VARA_RPC_URL.includes("127.0.0.1") || VARA_RPC_URL.includes("localhost");

const DEV_FUND_THRESHOLD = 100_000_000_000_000n;
const DEV_FUND_AMOUNT = 10_000_000_000_000_000n;

async function ensureDevFunded(api: any, targetAddress: string) {
  if (!isLocalNode || !api) return;
  const { Keyring } = await import("@polkadot/keyring");
  const accountData = await api.query.system.account(targetAddress);
  const free = BigInt(accountData.data.free.toString());
  if (free >= DEV_FUND_THRESHOLD) return;

  const keyring = new Keyring({ type: "sr25519" });
  const alice = keyring.addFromUri("//Alice");
  await new Promise<void>((resolve, reject) => {
    api.tx.balances
      .transferKeepAlive(targetAddress, DEV_FUND_AMOUNT)
      .signAndSend(alice, ({ status, isError }: { status: any; isError: boolean }) => {
        if (isError) reject(new Error("Failed to fund account from dev Alice"));
        if (status.isInBlock || status.isFinalized) resolve();
      });
  });
}

async function ensureSessionSignerFunded(api: any, owner: string) {
  const signer = await loadSessionSigner(owner);
  if (!signer) {
    return;
  }

  await ensureDevFunded(api, signer.address);
}

async function readNativeBalance(api: any, address: string) {
  const accountData = await api.query.system.account(address);
  return BigInt(accountData.data.free.toString());
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

type SailsQuery = <T>(origin: string, value?: bigint, atBlock?: HexString, ...args: unknown[]) => Promise<T>;

async function runSailsQuery<T>(query: SailsQuery | undefined, origin: string, ...args: unknown[]) {
  if (!query) {
    throw new Error("required Vara query is unavailable");
  }

  return query<T>(origin, 0n, undefined, ...args);
}

function uniqueActorIds(actors: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const actor of actors) {
    if (!actor || actor === ZERO_ACTOR) {
      continue;
    }
    const key = actor.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(actor);
  }
  return unique;
}

function dedupeOpenPositions(positions: VaraOpenPositionSnapshot[]) {
  const byPosition = new Map<string, VaraOpenPositionSnapshot>();
  for (const position of positions) {
    byPosition.set(`${position.trader.toLowerCase()}:${toBigInt(position.id).toString()}`, position);
  }
  return Array.from(byPosition.values());
}

async function readPositionsForTraders(
  positionsQuery: SailsQuery | undefined,
  origin: string,
  traders: Array<string | null | undefined>
) {
  const traderIds = uniqueActorIds(traders);
  const positionGroups = await Promise.all(
    traderIds.map((trader) => runSailsQuery<VaraOpenPositionSnapshot[]>(positionsQuery, origin, trader).catch(() => []))
  );
  return dedupeOpenPositions(positionGroups.flat());
}

async function waitForTokenAllowance(
  allowanceQuery: SailsQuery | undefined,
  owner: string,
  spender: string,
  minimum: bigint
) {
  const timeoutAt = Date.now() + 15_000;
  let latest = 0n;
  while (Date.now() < timeoutAt) {
    latest = toBigInt(
      await runSailsQuery<bigint | string | number | { toString(): string }>(allowanceQuery, owner, owner, spender)
    );
    if (latest >= minimum) {
      return latest;
    }
    await sleep(500);
  }

  throw new Error(
    `Token allowance did not settle in time. Visible allowance is ${formatUnits(latest, 6)} tUSDC, expected at least ${formatUnits(minimum, 6)} tUSDC.`
  );
}

type PositionInput = {
  side: "long" | "short";
  notional: number;
  leverage: number;
  maxSlippageBps: number;
};

type SponsoredVoucherRequest = {
  owner: string;
  session?: string;
  ownerPrograms: string[];
  sessionPrograms: string[];
};

const ALL_MARKET_PROGRAM_IDS = Object.values(VARA_MARKET_PROGRAM_IDS).filter((programId) => Boolean(programId));

function sameSponsoredVoucherBundle(left: VaraSponsoredVoucherBundle, right: VaraSponsoredVoucherBundle) {
  return (
    (left.owner?.voucherId ?? null) === (right.owner?.voucherId ?? null) &&
    (left.session?.voucherId ?? null) === (right.session?.voucherId ?? null)
  );
}

async function waitForTransactionResponse(result: { response: () => Promise<unknown> }, label: string) {
  await Promise.race([
    result.response(),
    sleep(45_000).then(() => {
      throw new Error(`${label} is still pending after 45s. Switch signless off or refresh the session and try again.`);
    })
  ]);
}

export function useVaraProgram(
  asset: Asset,
  mode: RuntimeMode,
  sessionToken: string | null,
  liveReferencePrice: number | null = null,
  preferSignless = false
) {
  const { account } = useAccount();
  const { api, isApiReady } = useApi();
  const alert = useAlert();
  const marketProgramId = getMarketProgramId(asset);
  const tokenSails = useSails({ idl: demoUsdcIdl, programId: VARA_DEMO_USDC_PROGRAM_ID });
  const sessionRegistrySails = useSails({ idl: sessionRegistryIdl, programId: VARA_SESSION_REGISTRY_PROGRAM_ID });
  const marketSails = useSails({ idl: perpMarketIdl, programId: marketProgramId });
  const vaultSails = useSails({ idl: marginVaultIdl, programId: VARA_MARGIN_VAULT_PROGRAM_ID });
  const poolSails = useSails({ idl: liquidityPoolIdl, programId: VARA_LIQUIDITY_POOL_PROGRAM_ID });
  const oracleSails = useSails({ idl: oracleServiceIdl, programId: VARA_ORACLE_SERVICE_PROGRAM_ID });
  const [onchainAccount, setOnchainAccount] = useState<AccountSnapshot | null>(null);
  const [onchainMarket, setOnchainMarket] = useState<MarketSnapshot | null>(null);
  const [onchainPositions, setOnchainPositions] = useState<PositionSnapshot[]>([]);
  const [onchainSession, setOnchainSession] = useState<ReturnType<typeof parseSession>>(null);
  const [onchainPool, setOnchainPool] = useState<{ totalLiquidity: string; maxOpenNotional: string; reservedNotional: string } | null>(null);
  const [localSessionSigner, setLocalSessionSigner] = useState<LocalSessionSigner | null>(null);
  const [sponsoredVouchers, setSponsoredVouchers] = useState<VaraSponsoredVoucherBundle>({ owner: null, session: null });
  const [refreshTick, setRefreshTick] = useState(0);
  const [actionPending, setActionPending] = useState(false);
  const actionPendingRef = useRef(false);
  const sponsorCooldownUntilRef = useRef(0);

  const walletAddress = account?.decodedAddress ?? ZERO_ACTOR;
  const sponsorConfigured = Boolean(VARA_VOUCHER_SPONSOR_URL);
  const isVaraReady = mode === "vara" && Boolean(
    account &&
      isApiReady &&
      VARA_DEMO_USDC_PROGRAM_ID &&
      VARA_SESSION_REGISTRY_PROGRAM_ID &&
      marketProgramId &&
      VARA_MARGIN_VAULT_PROGRAM_ID &&
      VARA_LIQUIDITY_POOL_PROGRAM_ID &&
      VARA_ORACLE_SERVICE_PROGRAM_ID
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (
        !isVaraReady ||
        !tokenSails.data ||
        !sessionRegistrySails.data ||
        !marketSails.data ||
        !vaultSails.data ||
        !poolSails.data ||
        !oracleSails.data ||
        walletAddress === ZERO_ACTOR
      ) {
        setOnchainAccount((current) => current === null ? current : null);
        setOnchainMarket((current) => current === null ? current : null);
        setOnchainPositions((current) => current.length === 0 ? current : []);
        setOnchainSession((current) => current === null ? current : null);
        setOnchainPool((current) => current === null ? current : null);
        return;
      }

      const tokenService = tokenSails.data.services.Token;
      const sessionRegistryService = sessionRegistrySails.data.services.SessionRegistry;
      const marketService = marketSails.data.services.Market;
      const vaultService = vaultSails.data.services.Vault;
      const poolService = poolSails.data.services.Pool;
      if (!tokenService || !sessionRegistryService || !marketService || !vaultService || !poolService) {
        setOnchainAccount((current) => current === null ? current : null);
        setOnchainMarket((current) => current === null ? current : null);
        setOnchainPositions((current) => current.length === 0 ? current : []);
        setOnchainSession((current) => current === null ? current : null);
        setOnchainPool((current) => current === null ? current : null);
        return;
      }

      try {
        const activeSessionQuery = sessionRegistryService.queries.ActiveSession;
        const marketStateQuery = marketService.queries.MarketState;
        const vaultAccountQuery = vaultService.queries.Account;
        const positionsQuery = marketService.queries.Positions;
        const balanceOfQuery = tokenService.queries.BalanceOf;
        const lpAccountQuery = poolService.queries.Account;
        const poolStateQuery = poolService.queries.PoolState;
        if (!activeSessionQuery || !marketStateQuery || !vaultAccountQuery || !positionsQuery || !balanceOfQuery || !lpAccountQuery || !poolStateQuery) {
          throw new Error("required Vara queries are unavailable");
        }

        const [session, market, vaultAccount, walletBalance, lpAccount, poolState] = await Promise.all([
          runSailsQuery<VaraSessionRecord | null>(activeSessionQuery, walletAddress, walletAddress),
          runSailsQuery<VaraMarketSnapshot>(marketStateQuery, walletAddress),
          runSailsQuery<VaraAccountSnapshot>(vaultAccountQuery, walletAddress, walletAddress),
          runSailsQuery<bigint>(balanceOfQuery, walletAddress, walletAddress),
          runSailsQuery<VaraLpAccount>(lpAccountQuery, walletAddress, walletAddress),
          runSailsQuery<VaraPoolState>(poolStateQuery, walletAddress)
        ]);
        const positions = await readPositionsForTraders(
          positionsQuery,
          walletAddress,
          [walletAddress, localSessionSigner?.actorId]
        );

        if (cancelled) {
          return;
        }

        setOnchainSession(parseSession(session));
        setOnchainMarket(parseMarket(asset, market));
        setOnchainAccount(parseTraderAccount(vaultAccount, walletBalance, lpAccount.shares));
        setOnchainPositions(
          positions.map((position) => {
            const positionId = Number(toBigInt(position.id));
            let displayEntryOverride = readDisplayEntryOverride(walletAddress, asset, positionId);
            if (!displayEntryOverride && liveReferencePrice && liveReferencePrice > 0) {
              displayEntryOverride = decimalToBigInt(liveReferencePrice, 8);
              writePositionDisplayOverride(
                walletAddress,
                asset,
                positionId,
                formatUnits(displayEntryOverride, 8)
              );
            }
            return parsePosition(
              asset,
              market,
              position,
              displayEntryOverride
            );
          })
        );
        setOnchainPool(parsePoolState(poolState));
      } catch (error) {
        if (!cancelled) {
          alert.error(error instanceof Error ? error.message : "Failed to read on-chain state", { title: "Vara query failed" });
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [alert, asset, isVaraReady, liveReferencePrice, localSessionSigner?.actorId, marketSails.data, oracleSails.data, poolSails.data, refreshTick, sessionRegistrySails.data, tokenSails.data, vaultSails.data, walletAddress]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateSigner() {
      if (walletAddress === ZERO_ACTOR) {
        setLocalSessionSigner((current) => current === null ? current : null);
        return;
      }

      const signer = await loadSessionSigner(walletAddress);
      if (!cancelled) {
        setLocalSessionSigner(
          signer
            ? {
                actorId: signer.actorId,
                address: signer.address,
                createdAt: signer.createdAt
              }
            : null
        );
      }
    }

    void hydrateSigner();

    return () => {
      cancelled = true;
    };
  }, [refreshTick, walletAddress]);

  useEffect(() => {
    if (walletAddress === ZERO_ACTOR) {
      setSponsoredVouchers((current) => (
        current.owner || current.session ? { owner: null, session: null } : current
      ));
    }
  }, [walletAddress]);

  const refresh = useCallback(() => {
    setRefreshTick((value) => value + 1);
  }, []);

  const syncMarketPrice = useCallback(async (markPrice: number, shouldRefresh = true) => {
    if (!isLocalNode || !api || !marketSails.data) {
      return;
    }

    const marketService = marketSails.data.services.Market;
    const updatePrice = marketService?.functions.UpdatePrice;
    if (!updatePrice) {
      return;
    }

    const { Keyring } = await import("@polkadot/keyring");
    const keyring = new Keyring({ type: "sr25519" });
    const alice = keyring.addFromUri("//Alice");
    const priceUnits = decimalToBigInt(markPrice, 8);
    const tx = updatePrice(priceUnits, priceUnits).withAccount(alice);
    await tx.calculateGas();
    await (await tx.signAndSend()).response();
    if (shouldRefresh) {
      refresh();
    }
  }, [api, marketSails.data, refresh]);

  const runAction = useCallback(
    async <T>(title: string, pendingMessage: string, successMessage: string, execute: () => Promise<T>, refreshOnSuccess = true) => {
      if (actionPendingRef.current) {
        throw new Error("Another Vara transaction is already pending. Wait for it to finish before submitting again.");
      }

      actionPendingRef.current = true;
      setActionPending(true);
      const alertId = alert.loading(pendingMessage, { title, timeout: 0 });
      try {
        const result = await execute();
        if (refreshOnSuccess) {
          refresh();
        }
        alert.update(alertId, successMessage, {
          title,
          timeout: 4000,
          type: "success"
        });
        return result;
      } catch (error) {
        alert.update(alertId, describeError(error), {
          title,
          timeout: 7000,
          type: "error"
        });
        throw error;
      } finally {
        actionPendingRef.current = false;
        setActionPending(false);
      }
    },
    [alert, refresh]
  );

  const hasSessionSigner = Boolean(
    onchainSession &&
      localSessionSigner &&
      onchainSession.sessionKey.toLowerCase() === localSessionSigner.actorId.toLowerCase()
  );
  const sponsorModeEnabled = preferSignless && sponsorConfigured;
  const signlessModeEnabled = preferSignless && hasSessionSigner;

  const ensureSponsoredAccess = useCallback(async (sessionAddress?: string | null) => {
    if (!account) {
      throw new Error("wallet is not connected");
    }
    if (!sponsorModeEnabled) {
      return { owner: null, session: null } as VaraSponsoredVoucherBundle;
    }
    if (Date.now() < sponsorCooldownUntilRef.current) {
      return { owner: null, session: null } as VaraSponsoredVoucherBundle;
    }

    const ownerPrograms = Array.from(
      new Set(
        [
          VARA_SESSION_REGISTRY_PROGRAM_ID,
          VARA_DEMO_USDC_PROGRAM_ID,
          VARA_MARGIN_VAULT_PROGRAM_ID,
          VARA_LIQUIDITY_POOL_PROGRAM_ID,
          ...ALL_MARKET_PROGRAM_IDS
        ].filter((programId): programId is string => Boolean(programId))
      )
    );
    const sessionPrograms = Array.from(
      new Set(
        [
          VARA_MARGIN_VAULT_PROGRAM_ID,
          ...ALL_MARKET_PROGRAM_IDS
        ].filter((programId): programId is string => Boolean(programId))
      )
    );

    const payload: SponsoredVoucherRequest = {
      owner: account.decodedAddress,
      ownerPrograms,
      sessionPrograms
    };
    if (sessionAddress) {
      payload.session = sessionAddress;
    }

    try {
      const response = await fetch(`${VARA_VOUCHER_SPONSOR_URL}/api/vouchers/ensure`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({ error: "sponsor request failed" })) as { error?: string };
        throw new Error(failure.error ?? `sponsor request failed: ${response.status}`);
      }

      const bundle = await response.json() as VaraSponsoredVoucherBundle;
      sponsorCooldownUntilRef.current = 0;
      setSponsoredVouchers((current) => sameSponsoredVoucherBundle(current, bundle) ? current : bundle);
      return bundle;
    } catch (error) {
      sponsorCooldownUntilRef.current = Date.now() + 60_000;
      console.error("voucher sponsor unavailable, falling back to signed/native flow", error);
      return { owner: null, session: null } as VaraSponsoredVoucherBundle;
    }
  }, [account, sponsorModeEnabled]);

  const applyOwnerContext = useCallback(async (tx: any, bundle?: VaraSponsoredVoucherBundle | null) => {
    if (!account) {
      throw new Error("wallet is not connected");
    }

    tx.withAccount(account.address, { signer: account.signer });
    if (!sponsorModeEnabled) {
      return null;
    }

    const currentBundle = bundle ?? (await ensureSponsoredAccess(null));
    const ownerVoucherId = currentBundle.owner?.voucherId;
    if (ownerVoucherId) {
      tx.withVoucher(ownerVoucherId as HexString);
    }
    return ownerVoucherId ?? null;
  }, [account, ensureSponsoredAccess, sponsorModeEnabled]);

  const applySessionOrOwnerContext = useCallback(async (tx: any, bundle?: VaraSponsoredVoucherBundle | null) => {
    if (!account) {
      throw new Error("wallet is not connected");
    }

    if (signlessModeEnabled) {
      await ensureSessionSignerFunded(api, account.decodedAddress);
      const signer = await loadSessionSigner(account.decodedAddress);
      if (!signer) {
        throw new Error("local session signer is unavailable");
      }
      const currentBundle = bundle ?? (await ensureSponsoredAccess(signer.address));
      const sessionVoucherId = currentBundle.session?.voucherId;
      const sessionNativeBalance = api ? await readNativeBalance(api, signer.address) : 0n;
      if (!sessionVoucherId && sessionNativeBalance < SESSION_MIN_NATIVE_BALANCE) {
        const ownerVoucherId = await applyOwnerContext(tx, currentBundle);
        return { signer: "owner" as const, voucherId: ownerVoucherId };
      }

      tx.withAccount(signer.pair);
      if (sessionVoucherId) {
        tx.withVoucher(sessionVoucherId as HexString);
      }
      return { signer: "session" as const, voucherId: sessionVoucherId ?? null };
    }

    const ownerVoucherId = await applyOwnerContext(tx, bundle);
    return { signer: "owner" as const, voucherId: ownerVoucherId };
  }, [account, api, applyOwnerContext, ensureSponsoredAccess, signlessModeEnabled]);

  const ensureAllowance = useCallback(async (
    allowanceQuery: SailsQuery | undefined,
    approve: ((...args: unknown[]) => any) | undefined,
    spender: string,
    minimum: bigint,
    bundle?: VaraSponsoredVoucherBundle | null
  ) => {
    if (!account) {
      throw new Error("wallet is not connected");
    }
    if (!approve) {
      throw new Error("approve function is unavailable");
    }

    const currentAllowance = toBigInt(
      await runSailsQuery<bigint | string | number | { toString(): string }>(
        allowanceQuery,
        account.decodedAddress,
        account.decodedAddress,
        spender
      )
    );
    if (currentAllowance >= minimum) {
      return currentAllowance;
    }

    const approveTx = approve(spender, MAX_U128);
    await applyOwnerContext(approveTx, bundle);
    await approveTx.calculateGas();
    await (await approveTx.signAndSend()).response();
    return waitForTokenAllowance(allowanceQuery, account.decodedAddress, spender, minimum);
  }, [account, applyOwnerContext]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateVouchers() {
      if (walletAddress === ZERO_ACTOR || !sponsorModeEnabled) {
        return;
      }

      try {
        const bundle = await ensureSponsoredAccess(signlessModeEnabled ? localSessionSigner?.address ?? null : null);
        if (!cancelled) {
          setSponsoredVouchers((current) => sameSponsoredVoucherBundle(current, bundle) ? current : bundle);
        }
      } catch {
        if (!cancelled) {
          setSponsoredVouchers((current) => (
            current.owner || current.session ? { owner: null, session: null } : current
          ));
        }
      }
    }

    void hydrateVouchers();

    return () => {
      cancelled = true;
    };
  }, [localSessionSigner?.address, signlessModeEnabled, sponsorModeEnabled, walletAddress]);

  return useMemo(
    () => ({
      asset,
      isVaraReady,
      isApiReady,
      onchainAccount,
      onchainMarket,
      onchainPositions,
      onchainSession,
      onchainPool,
      localSessionSigner,
      hasSessionSigner,
      signlessModeEnabled,
      gaslessEnabled: sponsorModeEnabled && sponsoredVouchers.owner !== null,
      signlessEnabled: sponsorModeEnabled && sponsoredVouchers.session !== null,
      actionPending,
      syncMarketPrice,
      async fundWalletGas() {
        return runAction("Gas", "Funding wallet gas...", "Wallet funded with local VARA gas.", async () => {
          if (!api || !account) {
            throw new Error("wallet or Vara API is not ready");
          }

          await ensureDevFunded(api, account.address);
        }, false);
      },
      async createSession(name?: string) {
        if (mode === "vara") {
          return runAction("Session", "Registering Vara session...", "Session registered and ready.", async () => {
            if (!isVaraReady || !sessionRegistrySails.data || !tokenSails.data || !account) {
              throw new Error("wallet, token, or session registry is not ready");
            }

            const sessionRegistryService = sessionRegistrySails.data.services.SessionRegistry;
            const tokenService = tokenSails.data.services.Token;
            if (!sessionRegistryService) {
              throw new Error("session registry service is unavailable");
            }
            if (!tokenService) {
              throw new Error("token service is unavailable");
            }

            const registerSession = sessionRegistryService.functions.RegisterSession;
            const approve = tokenService.functions.Approve;
            const allowanceQuery = tokenService.queries.Allowance;
            if (!registerSession || !approve || !allowanceQuery) {
              throw new Error("session registration or token approval surface is unavailable");
            }
            if (!api) {
              throw new Error("Vara API is unavailable");
            }

            await ensureDevFunded(api, account.address);

            const signer = await getOrCreateSessionSigner(account.decodedAddress);
            const voucherBundle = await ensureSponsoredAccess(signer.address);
            const currentBlock = Number((await api.query.system.number()).toString());
            const expiresAt = currentBlock + Math.max(1, VARA_SESSION_DURATION_BLOCKS);
            const permissions: VaraSessionPermissions = {
              trade: true,
              add_margin: true,
              withdraw: true
            };

            const tx = registerSession(signer.actorId, expiresAt, permissions);
            await applyOwnerContext(tx, voucherBundle);
            await tx.calculateGas();
            const result = await tx.signAndSend();
            await result.response();

            await ensureAllowance(
              allowanceQuery,
              approve,
              VARA_MARGIN_VAULT_PROGRAM_ID,
              MAX_U128 / 2n,
              voucherBundle
            );
            await ensureAllowance(
              allowanceQuery,
              approve,
              VARA_LIQUIDITY_POOL_PROGRAM_ID,
              MAX_U128 / 2n,
              voucherBundle
            );

            const configuredSessionFunding = parseVar(VARA_SESSION_FUNDING_AMOUNT);
            const sessionFunding = configuredSessionFunding > 0n
              ? configuredSessionFunding
              : SESSION_GAS_FUNDING_FALLBACK;
            if (api.tx.balances?.transferKeepAlive && !voucherBundle.session?.voucherId) {
              const currentFree = await readNativeBalance(api, signer.address);
              if (currentFree < sessionFunding) {
                await api.tx.balances
                  .transferKeepAlive(signer.address, sessionFunding)
                  .signAndSend(account.address, { signer: account.signer });
              }
            }
          });
        }

        return post<{ session: SessionSnapshot; snapshot: EngineSnapshot }>("/api/session", { name });
      },
      async revokeSession() {
        if (mode !== "vara") {
          return;
        }

        await runAction("Session", "Revoking Vara session...", "Session revoked.", async () => {
          if (!isVaraReady || !sessionRegistrySails.data || !account || !onchainSession) {
            throw new Error("wallet or active session is not ready");
          }

          const sessionRegistryService = sessionRegistrySails.data.services.SessionRegistry;
          if (!sessionRegistryService) {
            throw new Error("session registry service is unavailable");
          }

          const revokeSession = sessionRegistryService.functions.RevokeSession;
          if (!revokeSession) {
            throw new Error("revoke session function is unavailable");
          }

          const tx = revokeSession(onchainSession.sessionKey);
          await applyOwnerContext(tx);
          await tx.calculateGas();
          const result = await tx.signAndSend();
          await result.response();
          clearSessionSigner(account.decodedAddress);
          setSponsoredVouchers((current) => ({ owner: current.owner, session: null }));
        });
      },
      async deposit(amount: number) {
        if (mode === "demo") {
          if (!sessionToken) {
            throw new Error("start a session first");
          }
          return post<{ snapshot: EngineSnapshot }>("/api/account/deposit", { sessionToken, amount });
        }

        await runAction("Deposit", "Approving and depositing collateral...", "Collateral deposited.", async () => {
          if (!isVaraReady || !vaultSails.data || !tokenSails.data || !account) {
            throw new Error("wallet, token, or vault program is not ready");
          }
          await ensureDevFunded(api, account.address);

          const tokenService = tokenSails.data.services.Token;
          const vaultService = vaultSails.data.services.Vault;
          if (!tokenService || !vaultService) {
            throw new Error("token or vault service is unavailable");
          }

          const approve = tokenService.functions.Approve;
          const allowanceQuery = tokenService.queries.Allowance;
          const balanceOfQuery = tokenService.queries.BalanceOf;
          const deposit = vaultService.functions.Deposit;
          if (!approve || !deposit || !allowanceQuery || !balanceOfQuery) {
            throw new Error("token approve/deposit queries are unavailable");
          }

          const amountUnits = decimalToBigInt(amount, 6);
          const walletBalance = toBigInt(
            await runSailsQuery<bigint>(balanceOfQuery, account.decodedAddress, account.decodedAddress)
          );
          if (walletBalance < amountUnits) {
            throw new Error(
              `Wallet balance is only ${formatUnits(walletBalance, 6)} tUSDC, but deposit needs ${formatUnits(amountUnits, 6)} tUSDC. Mint or reduce the amount first.`
            );
          }

          const voucherBundle = await ensureSponsoredAccess(signlessModeEnabled ? localSessionSigner?.address ?? null : null);
          await ensureAllowance(
            allowanceQuery,
            approve,
            VARA_MARGIN_VAULT_PROGRAM_ID,
            amountUnits,
            voucherBundle
          );

          const tx = deposit(amountUnits);
          await applySessionOrOwnerContext(tx, voucherBundle);
          await tx.calculateGas();
          await (await tx.signAndSend()).response();
        });
      },
      async mintDemoTokens(amount: number) {
        if (mode === "demo") {
          if (!sessionToken) {
            throw new Error("start a session first");
          }
          return post<{ snapshot: EngineSnapshot }>("/api/demo-token/mint", { sessionToken, amount });
        }

        await runAction("Mint", "Minting demo collateral...", "Demo collateral minted.", async () => {
          if (!isVaraReady || !tokenSails.data || !account) {
            throw new Error("wallet or token program is not ready");
          }
          await ensureDevFunded(api, account.address);

          const tokenService = tokenSails.data.services.Token;
          if (!tokenService) {
            throw new Error("token service is unavailable");
          }

          const mint = tokenService.functions.Mint;
          if (!mint) {
            throw new Error("mint function is unavailable");
          }

          const tx = mint(decimalToBigInt(amount, 6));
          await applyOwnerContext(tx);
          await tx.calculateGas();
          await (await tx.signAndSend()).response();
        });
      },
      async provideDemoLiquidity(amount: number) {
        if (mode === "demo") {
          if (!sessionToken) {
            throw new Error("start a session first");
          }
          return post<{ snapshot: EngineSnapshot }>("/api/liquidity/provide", { sessionToken, amount });
        }

        await runAction("Liquidity", "Approving and funding the pool...", "Pool funded.", async () => {
          if (!isVaraReady || !tokenSails.data || !poolSails.data || !account) {
            throw new Error("wallet, token, or pool program is not ready");
          }
          await ensureDevFunded(api, account.address);

          const tokenService = tokenSails.data.services.Token;
          const poolService = poolSails.data.services.Pool;
          if (!tokenService || !poolService) {
            throw new Error("token or pool service is unavailable");
          }

          const approve = tokenService.functions.Approve;
          const allowanceQuery = tokenService.queries.Allowance;
          const balanceOfQuery = tokenService.queries.BalanceOf;
          const depositLiquidity = poolService.functions.DepositLiquidity;
          if (!approve || !depositLiquidity || !allowanceQuery || !balanceOfQuery) {
            throw new Error("token approve or pool deposit queries are unavailable");
          }

          const amountUnits = decimalToBigInt(amount, 6);
          const walletBalance = toBigInt(
            await runSailsQuery<bigint>(balanceOfQuery, account.decodedAddress, account.decodedAddress)
          );
          if (walletBalance < amountUnits) {
            throw new Error(
              `Wallet balance is only ${formatUnits(walletBalance, 6)} tUSDC, but LP funding needs ${formatUnits(amountUnits, 6)} tUSDC. Mint or reduce the amount first.`
            );
          }

          const voucherBundle = await ensureSponsoredAccess(signlessModeEnabled ? localSessionSigner?.address ?? null : null);
          await ensureAllowance(
            allowanceQuery,
            approve,
            VARA_LIQUIDITY_POOL_PROGRAM_ID,
            amountUnits,
            voucherBundle
          );

          const tx = depositLiquidity(amountUnits);
          await applyOwnerContext(tx, voucherBundle);
          await tx.calculateGas();
          await (await tx.signAndSend()).response();
        });
      },
      async withdraw(amount: number) {
        if (mode === "demo") {
          if (!sessionToken) {
            throw new Error("start a session first");
          }
          return post<{ snapshot: EngineSnapshot }>("/api/account/withdraw", { sessionToken, amount });
        }

        await runAction("Withdraw", "Withdrawing collateral...", "Collateral withdrawn.", async () => {
          if (!isVaraReady || !vaultSails.data || !account) {
            throw new Error("wallet or vault program is not ready");
          }
          await ensureDevFunded(api, account.address);

          const vaultService = vaultSails.data.services.Vault;
          if (!vaultService) {
            throw new Error("vault service is unavailable");
          }

          const withdraw = vaultService.functions.Withdraw;
          if (!withdraw) {
            throw new Error("withdraw function is unavailable");
          }

          const tx = withdraw(decimalToBigInt(amount, 6));
          await applySessionOrOwnerContext(tx);
          await tx.calculateGas();
          await (await tx.signAndSend()).response();
        });
      },
      async openPosition(input: PositionInput) {
        if (mode === "demo") {
          if (!sessionToken) {
            throw new Error("start a session first");
          }
          return post<{ snapshot: EngineSnapshot }>("/api/orders/open", { sessionToken, asset, ...input });
        }

        await runAction("Trade", `Opening ${input.side} position...`, "Position opened.", async () => {
          if (!isVaraReady || !marketSails.data || !account || !onchainMarket) {
            throw new Error("wallet or market program is not ready");
          }
          await ensureDevFunded(api, account.address);

          const marketService = marketSails.data.services.Market;
          if (!marketService) {
            throw new Error("market service is unavailable");
          }

          const notional = decimalToBigInt(input.notional, 6);
          const livePrice = liveReferencePrice ?? Number(onchainMarket.markPrice);
          if (isLocalNode && livePrice > 0) {
            await syncMarketPrice(livePrice, false);
          }
          const executionPrice = Number(onchainMarket.markPrice);
          const markPrice = decimalToBigInt(executionPrice, 8);
          if (markPrice === 0n) {
            throw new Error("market price is unavailable");
          }

          const size = (notional * SIZE_FROM_NOTIONAL_SCALE) / markPrice;
          const actualNotional = (size * markPrice) / PRICE_SCALE / PRICE_TO_COLLATERAL_SCALE;
          const margin = divCeil(actualNotional, BigInt(input.leverage)) + 10_000n;
          const displayEntryPrice = livePrice > 0 ? livePrice : executionPrice;
          const displayEntryUnits = decimalToBigInt(displayEntryPrice, 8);
          const side = input.side === "long" ? "Long" : "Short";
          const openPosition = marketService.functions.OpenPosition;
          if (!openPosition) {
            throw new Error("open position function is unavailable");
          }

          const tx = openPosition(side, size, input.leverage, margin, input.maxSlippageBps);
          await applySessionOrOwnerContext(tx);
          tx.withGas(isLocalNode ? "max" : TRADE_GAS_LIMIT);
          const result = await tx.signAndSend();
          await waitForTransactionResponse(result, "Trade transaction");

          const positionsQuery = marketService.queries.Positions;
          if (positionsQuery && executionPrice > 0) {
            const latestPositions = await readPositionsForTraders(
              positionsQuery,
              walletAddress,
              [walletAddress, localSessionSigner?.actorId]
            );
            latestPositions
              .forEach((position) => {
                const positionId = Number(toBigInt(position.id));
                const latestSize = toBigInt(position.position.size);
                const previous = onchainPositions.find((item) => item.asset === asset && item.id === positionId) ?? null;
                const previousEntryUnits = previous
                  ? decimalToBigInt(Number(previous.entryPrice), 8)
                  : null;
                const previousSize = previous
                  ? decimalToBigInt(Number(previous.size), 8)
                  : 0n;
                const isSameSideAdd = previous && previous.side === input.side && previousSize > 0n;
                const isStillPreviousSide = previous && (
                  (previous.side === "long" && latestSize > 0n) ||
                  (previous.side === "short" && latestSize < 0n)
                );
                const overrideEntry = isSameSideAdd && previousEntryUnits
                  ? ((previousSize * previousEntryUnits) + (size * displayEntryUnits)) / (previousSize + size)
                  : isStillPreviousSide && previousEntryUnits
                    ? previousEntryUnits
                    : displayEntryUnits;
                writePositionDisplayOverride(
                  account.decodedAddress,
                  asset,
                  positionId,
                  formatUnits(overrideEntry, 8)
                );
              });
            const marketStateQuery = marketService.queries.MarketState;
            const latestMarket = marketStateQuery
              ? await runSailsQuery<VaraMarketSnapshot>(marketStateQuery, walletAddress)
              : null;
            if (latestMarket) {
              setOnchainMarket(parseMarket(asset, latestMarket));
              setOnchainPositions(
                latestPositions.map((position) => {
                  const positionId = Number(toBigInt(position.id));
                  return parsePosition(
                    asset,
                    latestMarket,
                    position,
                    readDisplayEntryOverride(account.decodedAddress, asset, positionId)
                  );
                })
              );
            }
          }
        });
      },
      async closePosition(positionToClose: PositionSnapshot) {
        if (mode === "demo") {
          if (!sessionToken) {
            throw new Error("start a session first");
          }
          return post<{ snapshot: EngineSnapshot }>("/api/orders/close", { sessionToken, asset: positionToClose.asset });
        }

        await runAction("Trade", "Closing position...", "Position closed.", async () => {
          if (positionToClose.asset !== asset) {
            throw new Error(`Switch to the ${positionToClose.asset} market tab before closing this position`);
          }

          if (!isVaraReady || !marketSails.data || !account) {
            throw new Error("wallet or position is not ready");
          }
          await ensureDevFunded(api, account.address);
          if (isLocalNode && liveReferencePrice && liveReferencePrice > 0) {
            await syncMarketPrice(liveReferencePrice, false);
          }

          const marketService = marketSails.data.services.Market;
          if (!marketService) {
            throw new Error("market service is unavailable");
          }

          const closeSize = decimalToBigInt(Number(positionToClose.size), 8);
          const closePosition = marketService.functions.ClosePosition;
          if (!closePosition) {
            throw new Error("close position function is unavailable");
          }

          const tx = closePosition(positionToClose.id, closeSize);
          await applySessionOrOwnerContext(tx);
          tx.withGas(isLocalNode ? "max" : TRADE_GAS_LIMIT);
          const result = await tx.signAndSend();
          await waitForTransactionResponse(result, "Close transaction");
          deletePositionDisplayOverride(account.decodedAddress, asset, positionToClose.id);
        });
      }
    }),
    [account, actionPending, api, applyOwnerContext, applySessionOrOwnerContext, asset, ensureAllowance, ensureSponsoredAccess, hasSessionSigner, isApiReady, isVaraReady, liveReferencePrice, localSessionSigner, marketSails.data, mode, onchainAccount, onchainMarket, onchainPool, onchainPositions, onchainSession, poolSails.data, preferSignless, runAction, sessionRegistrySails.data, sessionToken, signlessModeEnabled, sponsorModeEnabled, sponsoredVouchers.owner, sponsoredVouchers.session, syncMarketPrice, tokenSails.data, vaultSails.data]
  );
}
