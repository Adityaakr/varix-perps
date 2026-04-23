import { useAccount, useAlert, useApi, useSails } from "@gear-js/react-hooks";
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
  VARA_MARGIN_VAULT_PROGRAM_ID,
  VARA_ORACLE_SERVICE_PROGRAM_ID,
  VARA_RPC_URL,
  VARA_SESSION_DURATION_BLOCKS,
  VARA_SESSION_FUNDING_AMOUNT,
  VARA_SESSION_REGISTRY_PROGRAM_ID,
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
  VaraPoolState,
  VaraPositionSnapshot,
  VaraSessionPermissions,
  VaraSessionRecord
} from "../types";

const ZERO_ACTOR = `0x${"0".repeat(64)}`;
const PRICE_SCALE = 100_000_000n;
const PRICE_TO_COLLATERAL_SCALE = 100n;
const SIZE_FROM_NOTIONAL_SCALE = PRICE_SCALE * PRICE_TO_COLLATERAL_SCALE;

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

function parsePosition(asset: Asset, trader: string, market: VaraMarketSnapshot, position: VaraPositionSnapshot): PositionSnapshot {
  const positionSize = toBigInt(position.size);
  const mark = toBigInt(market.mark_price);
  const entry = toBigInt(position.entry_price);
  const margin = toBigInt(position.margin);
  const openedAt = toBigInt(position.opened_at);
  const side = positionSize >= 0n ? "long" : "short";
  const size = positionSize >= 0n ? positionSize : -positionSize;
  const pnlBase = (mark - entry) * positionSize;
  const pnl = pnlBase / PRICE_SCALE / PRICE_TO_COLLATERAL_SCALE;
  const liquidationPrice = size === 0n
    ? entry
    : side === "long"
      ? entry - (margin * PRICE_SCALE * PRICE_TO_COLLATERAL_SCALE) / size
      : entry + (margin * PRICE_SCALE * PRICE_TO_COLLATERAL_SCALE) / size;

  return {
    trader,
    asset,
    side,
    size: formatUnits(size, 8),
    notional: formatUnits((size * mark) / PRICE_SCALE / PRICE_TO_COLLATERAL_SCALE, 6),
    entryPrice: formatUnits(entry, 8),
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

type PositionInput = {
  side: "long" | "short";
  notional: number;
  leverage: number;
  maxSlippageBps: number;
};

export function useVaraProgram(asset: Asset, mode: RuntimeMode, sessionToken: string | null, liveReferencePrice: number | null = null) {
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
  const [onchainPosition, setOnchainPosition] = useState<PositionSnapshot | null>(null);
  const [onchainSession, setOnchainSession] = useState<ReturnType<typeof parseSession>>(null);
  const [onchainPool, setOnchainPool] = useState<{ totalLiquidity: string; maxOpenNotional: string; reservedNotional: string } | null>(null);
  const [localSessionSigner, setLocalSessionSigner] = useState<LocalSessionSigner | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [actionPending, setActionPending] = useState(false);
  const actionPendingRef = useRef(false);

  const walletAddress = account?.decodedAddress ?? ZERO_ACTOR;
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
        !account
      ) {
        setOnchainAccount(null);
        setOnchainMarket(null);
        setOnchainPosition(null);
        setOnchainSession(null);
        setOnchainPool(null);
        return;
      }

      const tokenService = tokenSails.data.services.Token;
      const sessionRegistryService = sessionRegistrySails.data.services.SessionRegistry;
      const marketService = marketSails.data.services.Market;
      const vaultService = vaultSails.data.services.Vault;
      const poolService = poolSails.data.services.Pool;
      if (!tokenService || !sessionRegistryService || !marketService || !vaultService || !poolService) {
        setOnchainAccount(null);
        setOnchainMarket(null);
        setOnchainPosition(null);
        setOnchainSession(null);
        setOnchainPool(null);
        return;
      }

      try {
        const activeSessionQuery = sessionRegistryService.queries.ActiveSession;
        const marketStateQuery = marketService.queries.MarketState;
        const vaultAccountQuery = vaultService.queries.Account;
        const positionQuery = marketService.queries.Position;
        const balanceOfQuery = tokenService.queries.BalanceOf;
        const lpAccountQuery = poolService.queries.Account;
        const poolStateQuery = poolService.queries.PoolState;
        if (!activeSessionQuery || !marketStateQuery || !vaultAccountQuery || !positionQuery || !balanceOfQuery || !lpAccountQuery || !poolStateQuery) {
          throw new Error("required Vara queries are unavailable");
        }

        const [session, market, vaultAccount, position, walletBalance, lpAccount, poolState] = await Promise.all([
          activeSessionQuery<VaraSessionRecord | null>(walletAddress, undefined, undefined, walletAddress),
          marketStateQuery<VaraMarketSnapshot>(walletAddress),
          vaultAccountQuery<VaraAccountSnapshot>(walletAddress, undefined, undefined, walletAddress),
          positionQuery<VaraPositionSnapshot | null>(walletAddress, undefined, undefined, walletAddress),
          balanceOfQuery<bigint>(walletAddress, undefined, undefined, walletAddress),
          lpAccountQuery<VaraLpAccount>(walletAddress, undefined, undefined, walletAddress),
          poolStateQuery<VaraPoolState>(walletAddress)
        ]);

        if (cancelled) {
          return;
        }

        setOnchainSession(parseSession(session));
        setOnchainMarket(parseMarket(asset, market));
        setOnchainAccount(parseTraderAccount(vaultAccount, walletBalance, lpAccount.shares));
        setOnchainPosition(position ? parsePosition(asset, account.address, market, position) : null);
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
  }, [account, alert, asset, isVaraReady, marketSails.data, oracleSails.data, poolSails.data, refreshTick, sessionRegistrySails.data, tokenSails.data, vaultSails.data, walletAddress]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateSigner() {
      if (!account) {
        setLocalSessionSigner(null);
        return;
      }

      const signer = await loadSessionSigner(account.decodedAddress);
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
  }, [account, refreshTick]);

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

  return useMemo(
    () => ({
      asset,
      isVaraReady,
      isApiReady,
      onchainAccount,
      onchainMarket,
      onchainPosition,
      onchainSession,
      onchainPool,
      localSessionSigner,
      hasSessionSigner,
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
            if (!isVaraReady || !sessionRegistrySails.data || !account) {
              throw new Error("wallet or session registry is not ready");
            }

            const sessionRegistryService = sessionRegistrySails.data.services.SessionRegistry;
            if (!sessionRegistryService) {
              throw new Error("session registry service is unavailable");
            }

            const registerSession = sessionRegistryService.functions.RegisterSession;
            if (!registerSession) {
              throw new Error("register session function is unavailable");
            }
            if (!api) {
              throw new Error("Vara API is unavailable");
            }

            await ensureDevFunded(api, account.address);

            const signer = await getOrCreateSessionSigner(account.decodedAddress);
            const currentBlock = Number((await api.query.system.number()).toString());
            const expiresAt = currentBlock + Math.max(1, VARA_SESSION_DURATION_BLOCKS);
            const permissions: VaraSessionPermissions = {
              trade: true,
              add_margin: true,
              withdraw: true
            };

            const tx = registerSession(signer.actorId, expiresAt, permissions)
              .withAccount(account.address, { signer: account.signer });
            await tx.calculateGas();
            const result = await tx.signAndSend();
            await result.response();

            const sessionFunding = parseVar(VARA_SESSION_FUNDING_AMOUNT);
            if (sessionFunding > 0n && api.tx.balances?.transferKeepAlive) {
              const accountData = await api.query.system.account(signer.address);
              const currentFree = BigInt(accountData.data.free.toString());
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

          const tx = revokeSession(onchainSession.sessionKey)
            .withAccount(account.address, { signer: account.signer });
          await tx.calculateGas();
          const result = await tx.signAndSend();
          await result.response();
          clearSessionSigner(account.decodedAddress);
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
          const deposit = vaultService.functions.Deposit;
          if (!approve || !deposit) {
            throw new Error("token approve or vault deposit function is unavailable");
          }

          const amountUnits = decimalToBigInt(amount, 6);
          const approveTx = approve(VARA_MARGIN_VAULT_PROGRAM_ID, amountUnits)
            .withAccount(account.address, { signer: account.signer });
          await approveTx.calculateGas();
          await (await approveTx.signAndSend()).response();

          const tx = deposit(amountUnits);
          if (hasSessionSigner) {
            await ensureSessionSignerFunded(api, account.decodedAddress);
            const signer = await loadSessionSigner(account.decodedAddress);
            if (!signer) {
              throw new Error("local session signer is unavailable");
            }
            tx.withAccount(signer.pair);
          } else {
            tx.withAccount(account.address, { signer: account.signer });
          }
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

          const tx = mint(decimalToBigInt(amount, 6))
            .withAccount(account.address, { signer: account.signer });
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
          const depositLiquidity = poolService.functions.DepositLiquidity;
          if (!approve || !depositLiquidity) {
            throw new Error("token approve or pool deposit function is unavailable");
          }

          const amountUnits = decimalToBigInt(amount, 6);
          const approveTx = approve(VARA_LIQUIDITY_POOL_PROGRAM_ID, amountUnits)
            .withAccount(account.address, { signer: account.signer });
          await approveTx.calculateGas();
          await (await approveTx.signAndSend()).response();

          const tx = depositLiquidity(amountUnits)
            .withAccount(account.address, { signer: account.signer });
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
          if (hasSessionSigner) {
            await ensureSessionSignerFunded(api, account.decodedAddress);
            const signer = await loadSessionSigner(account.decodedAddress);
            if (!signer) {
              throw new Error("local session signer is unavailable");
            }
            tx.withAccount(signer.pair);
          } else {
            tx.withAccount(account.address, { signer: account.signer });
          }
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
          const referencePrice = liveReferencePrice ?? Number(onchainMarket.markPrice);
          if (isLocalNode && referencePrice > 0) {
            await syncMarketPrice(referencePrice, false);
          }
          const markPrice = decimalToBigInt(referencePrice, 8);
          if (markPrice === 0n) {
            throw new Error("market price is unavailable");
          }

          const size = (notional * SIZE_FROM_NOTIONAL_SCALE) / markPrice;
          const actualNotional = (size * markPrice) / PRICE_SCALE / PRICE_TO_COLLATERAL_SCALE;
          const margin = divCeil(actualNotional, BigInt(input.leverage)) + 1n;
          const side = input.side === "long" ? "Long" : "Short";
          const openPosition = marketService.functions.OpenPosition;
          if (!openPosition) {
            throw new Error("open position function is unavailable");
          }

          const tx = openPosition(side, size, input.leverage, margin, input.maxSlippageBps);
          if (hasSessionSigner) {
            await ensureSessionSignerFunded(api, account.decodedAddress);
            const signer = await loadSessionSigner(account.decodedAddress);
            if (!signer) {
              throw new Error("local session signer is unavailable");
            }
            tx.withAccount(signer.pair);
          } else {
            tx.withAccount(account.address, { signer: account.signer });
          }
          // Trade methods schedule delayed self-messages for liquidation/funding,
          // which can trip Gear's dry-run "forbidden function" guard during gas estimation.
          // Use block max gas in local dev to avoid false-negative calculateGas failures.
          tx.withGas("max");
          await (await tx.signAndSend()).response();
        });
      },
      async closePosition(closeAsset: Asset) {
        if (mode === "demo") {
          if (!sessionToken) {
            throw new Error("start a session first");
          }
          return post<{ snapshot: EngineSnapshot }>("/api/orders/close", { sessionToken, asset: closeAsset });
        }

        await runAction("Trade", "Closing position...", "Position closed.", async () => {
          if (closeAsset !== asset) {
            throw new Error(`Switch to the ${closeAsset} market tab before closing this position`);
          }

          if (!isVaraReady || !marketSails.data || !account || !onchainPosition) {
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

          const closeSize = decimalToBigInt(Number(onchainPosition.size), 8);
          const closePosition = marketService.functions.ClosePosition;
          if (!closePosition) {
            throw new Error("close position function is unavailable");
          }

          const tx = closePosition(closeSize);
          if (hasSessionSigner) {
            await ensureSessionSignerFunded(api, account.decodedAddress);
            const signer = await loadSessionSigner(account.decodedAddress);
            if (!signer) {
              throw new Error("local session signer is unavailable");
            }
            tx.withAccount(signer.pair);
          } else {
            tx.withAccount(account.address, { signer: account.signer });
          }
          tx.withGas("max");
          await (await tx.signAndSend()).response();
        });
      }
    }),
    [account, actionPending, api, asset, hasSessionSigner, isApiReady, isVaraReady, liveReferencePrice, localSessionSigner, marketSails.data, mode, onchainAccount, onchainMarket, onchainPool, onchainPosition, onchainSession, poolSails.data, runAction, sessionRegistrySails.data, sessionToken, syncMarketPrice, tokenSails.data, vaultSails.data]
  );
}
