import { useAccount, useAlert, useApi, useSails } from "@gear-js/react-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import marginVaultIdl from "../idl/margin-vault.idl?raw";
import oracleServiceIdl from "../idl/oracle-service.idl?raw";
import perpMarketIdl from "../idl/perp-market.idl?raw";
import sessionRegistryIdl from "../idl/session-registry.idl?raw";
import {
  INDEXER_HTTP_URL,
  VARA_MARGIN_VAULT_PROGRAM_ID,
  VARA_ORACLE_SERVICE_PROGRAM_ID,
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
  VaraMarketSnapshot,
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

function decimalToBigInt(value: number, decimals: number) {
  return BigInt(Math.round(value * 10 ** decimals));
}

function parseTraderAccount(account: VaraAccountSnapshot): AccountSnapshot {
  const free = formatUnits(account.free, 6);
  const locked = formatUnits(account.locked, 6);
  const equityValue = account.free + account.locked;

  return {
    trader: "wallet",
    walletBalance: "0",
    freeCollateral: free,
    lockedCollateral: locked,
    equity: formatUnits(equityValue, 6),
    realizedPnl: "0",
    totalDeposited: free,
    totalWithdrawn: "0",
    lpShares: "0"
  };
}

function parseMarket(asset: Asset, market: VaraMarketSnapshot): MarketSnapshot {
  return {
    asset,
    markPrice: formatUnits(market.mark_price, 8),
    indexPrice: formatUnits(market.index_price, 8),
    fundingRateBps: Number(market.funding_rate_bps),
    cumulativeFundingRateBps: Number(market.cumulative_funding_rate_bps),
    openInterestLong: formatUnits(market.open_interest_long, 8),
    openInterestShort: formatUnits(market.open_interest_short, 8),
    updatedAt: Date.now()
  };
}

function parsePosition(asset: Asset, trader: string, market: VaraMarketSnapshot, position: VaraPositionSnapshot): PositionSnapshot {
  const side = position.size >= 0n ? "long" : "short";
  const size = position.size >= 0n ? position.size : -position.size;
  const mark = market.mark_price;
  const entry = position.entry_price;
  const pnlBase = (mark - entry) * position.size;
  const pnl = pnlBase / PRICE_SCALE / PRICE_TO_COLLATERAL_SCALE;
  const liquidationPrice = side === "long"
    ? entry - (position.margin * PRICE_SCALE * PRICE_TO_COLLATERAL_SCALE) / size
    : entry + (position.margin * PRICE_SCALE * PRICE_TO_COLLATERAL_SCALE) / size;

  return {
    trader,
    asset,
    side,
    size: formatUnits(size, 8),
    notional: formatUnits((size * mark) / PRICE_SCALE / PRICE_TO_COLLATERAL_SCALE, 6),
    entryPrice: formatUnits(entry, 8),
    margin: formatUnits(position.margin, 6),
    leverage: position.leverage,
    liquidationPrice: formatUnits(liquidationPrice, 8),
    pnl: formatUnits(pnl, 6),
    updatedAt: Number(position.opened_at)
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

type PositionInput = {
  side: "long" | "short";
  notional: number;
  leverage: number;
  maxSlippageBps: number;
};

export function useVaraProgram(asset: Asset, mode: RuntimeMode, sessionToken: string | null) {
  const { account } = useAccount();
  const { api, isApiReady } = useApi();
  const alert = useAlert();
  const marketProgramId = getMarketProgramId(asset);
  const sessionRegistrySails = useSails({ idl: sessionRegistryIdl, programId: VARA_SESSION_REGISTRY_PROGRAM_ID });
  const marketSails = useSails({ idl: perpMarketIdl, programId: marketProgramId });
  const vaultSails = useSails({ idl: marginVaultIdl, programId: VARA_MARGIN_VAULT_PROGRAM_ID });
  const oracleSails = useSails({ idl: oracleServiceIdl, programId: VARA_ORACLE_SERVICE_PROGRAM_ID });
  const [onchainAccount, setOnchainAccount] = useState<AccountSnapshot | null>(null);
  const [onchainMarket, setOnchainMarket] = useState<MarketSnapshot | null>(null);
  const [onchainPosition, setOnchainPosition] = useState<PositionSnapshot | null>(null);
  const [onchainSession, setOnchainSession] = useState<ReturnType<typeof parseSession>>(null);
  const [localSessionSigner, setLocalSessionSigner] = useState<LocalSessionSigner | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const walletAddress = account?.decodedAddress ?? ZERO_ACTOR;
  const isVaraReady = mode === "vara" && Boolean(
    account &&
      isApiReady &&
      VARA_SESSION_REGISTRY_PROGRAM_ID &&
      marketProgramId &&
      VARA_MARGIN_VAULT_PROGRAM_ID &&
      VARA_ORACLE_SERVICE_PROGRAM_ID
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!isVaraReady || !sessionRegistrySails.data || !marketSails.data || !vaultSails.data || !oracleSails.data || !account) {
        setOnchainAccount(null);
        setOnchainMarket(null);
        setOnchainPosition(null);
        setOnchainSession(null);
        return;
      }

      const sessionRegistryService = sessionRegistrySails.data.services.SessionRegistry;
      const marketService = marketSails.data.services.Market;
      const vaultService = vaultSails.data.services.Vault;
      if (!sessionRegistryService || !marketService || !vaultService) {
        setOnchainAccount(null);
        setOnchainMarket(null);
        setOnchainPosition(null);
        setOnchainSession(null);
        return;
      }

      try {
        const activeSessionQuery = sessionRegistryService.queries.ActiveSession;
        const marketStateQuery = marketService.queries.MarketState;
        const vaultAccountQuery = vaultService.queries.Account;
        const positionQuery = marketService.queries.Position;
        if (!activeSessionQuery || !marketStateQuery || !vaultAccountQuery || !positionQuery) {
          throw new Error("required Vara queries are unavailable");
        }

        const session = await activeSessionQuery<VaraSessionRecord | null>(
          walletAddress,
          undefined,
          undefined,
          walletAddress
        );
        const market = await marketStateQuery<VaraMarketSnapshot>(walletAddress);
        const vaultAccount = await vaultAccountQuery<VaraAccountSnapshot>(
          walletAddress,
          undefined,
          undefined,
          walletAddress
        );
        const position = await positionQuery<VaraPositionSnapshot | null>(
          walletAddress,
          undefined,
          undefined,
          walletAddress
        );

        if (cancelled) {
          return;
        }

        setOnchainSession(parseSession(session));
        setOnchainMarket(parseMarket(asset, market));
        setOnchainAccount(parseTraderAccount(vaultAccount));
        setOnchainPosition(position ? parsePosition(asset, account.address, market, position) : null);
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
  }, [account, alert, asset, isVaraReady, marketSails.data, oracleSails.data, refreshTick, sessionRegistrySails.data, vaultSails.data, walletAddress]);

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

  const hasSessionSigner = Boolean(
    onchainSession &&
      localSessionSigner &&
      onchainSession.sessionKey.toLowerCase() === localSessionSigner.actorId.toLowerCase()
  );

  return useMemo(
    () => ({
      asset,
      isVaraReady,
      onchainAccount,
      onchainMarket,
      onchainPosition,
      onchainSession,
      localSessionSigner,
      hasSessionSigner,
      async createSession(name?: string) {
        if (mode === "vara") {
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

          const signer = await getOrCreateSessionSigner(account.decodedAddress);
          const currentBlock = Number((await api.query.system.number()).toString());
          const expiresAt = currentBlock + Math.max(1, VARA_SESSION_DURATION_BLOCKS);
          const permissions: VaraSessionPermissions = {
            trade: true,
            add_margin: true,
            withdraw: true
          };

          const tx = registerSession(signer.actorId, expiresAt, permissions)
            .withAccount(account.decodedAddress, { signer: account.signer });
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
                .signAndSend(account.decodedAddress, { signer: account.signer });
            }
          }

          refresh();
          return;
        }

        return post<{ session: SessionSnapshot; snapshot: EngineSnapshot }>("/api/session", { name });
      },
      async revokeSession() {
        if (mode !== "vara") {
          return;
        }

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
          .withAccount(account.decodedAddress, { signer: account.signer });
        await tx.calculateGas();
        const result = await tx.signAndSend();
        await result.response();
        clearSessionSigner(account.decodedAddress);
        refresh();
      },
      async deposit(amount: number) {
        if (mode === "demo") {
          if (!sessionToken) {
            throw new Error("start a session first");
          }
          return post<{ snapshot: EngineSnapshot }>("/api/account/deposit", { sessionToken, amount });
        }

        if (!isVaraReady || !vaultSails.data || !account) {
          throw new Error("wallet or vault program is not ready");
        }

        const vaultService = vaultSails.data.services.Vault;
        if (!vaultService) {
          throw new Error("vault service is unavailable");
        }

        const deposit = vaultService.functions.Deposit;
        if (!deposit) {
          throw new Error("deposit function is unavailable");
        }

        const tx = deposit(decimalToBigInt(amount, 6));
        if (hasSessionSigner) {
          const signer = await loadSessionSigner(account.decodedAddress);
          if (!signer) {
            throw new Error("local session signer is unavailable");
          }
          tx.withAccount(signer.pair);
        } else {
          tx.withAccount(account.decodedAddress, { signer: account.signer });
        }
        await tx.calculateGas();
        const result = await tx.signAndSend();
        await result.response();
        refresh();
      },
      async mintDemoTokens(amount: number) {
        if (!sessionToken) {
          throw new Error("start a session first");
        }
        return post<{ snapshot: EngineSnapshot }>("/api/demo-token/mint", { sessionToken, amount });
      },
      async provideDemoLiquidity(amount: number) {
        if (!sessionToken) {
          throw new Error("start a session first");
        }
        return post<{ snapshot: EngineSnapshot }>("/api/liquidity/provide", { sessionToken, amount });
      },
      async withdraw(amount: number) {
        if (mode === "demo") {
          if (!sessionToken) {
            throw new Error("start a session first");
          }
          return post<{ snapshot: EngineSnapshot }>("/api/account/withdraw", { sessionToken, amount });
        }

        if (!isVaraReady || !vaultSails.data || !account) {
          throw new Error("wallet or vault program is not ready");
        }

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
          const signer = await loadSessionSigner(account.decodedAddress);
          if (!signer) {
            throw new Error("local session signer is unavailable");
          }
          tx.withAccount(signer.pair);
        } else {
          tx.withAccount(account.decodedAddress, { signer: account.signer });
        }
        await tx.calculateGas();
        const result = await tx.signAndSend();
        await result.response();
        refresh();
      },
      async openPosition(input: PositionInput) {
        if (mode === "demo") {
          if (!sessionToken) {
            throw new Error("start a session first");
          }
          return post<{ snapshot: EngineSnapshot }>("/api/orders/open", { sessionToken, asset, ...input });
        }

        if (!isVaraReady || !marketSails.data || !account || !onchainMarket) {
          throw new Error("wallet or market program is not ready");
        }

        const marketService = marketSails.data.services.Market;
        if (!marketService) {
          throw new Error("market service is unavailable");
        }

        const notional = decimalToBigInt(input.notional, 6);
        const margin = notional / BigInt(input.leverage);
        const markPrice = decimalToBigInt(Number(onchainMarket.markPrice), 8);
        if (markPrice === 0n) {
          throw new Error("market price is unavailable");
        }

        const size = (notional * SIZE_FROM_NOTIONAL_SCALE) / markPrice;
        const side = input.side === "long" ? "Long" : "Short";
        const openPosition = marketService.functions.OpenPosition;
        if (!openPosition) {
          throw new Error("open position function is unavailable");
        }

        const tx = openPosition(side, size, input.leverage, margin, input.maxSlippageBps);
        if (hasSessionSigner) {
          const signer = await loadSessionSigner(account.decodedAddress);
          if (!signer) {
            throw new Error("local session signer is unavailable");
          }
          tx.withAccount(signer.pair);
        } else {
          tx.withAccount(account.decodedAddress, { signer: account.signer });
        }
        await tx.calculateGas();
        const result = await tx.signAndSend();
        await result.response();
        refresh();
      },
      async closePosition(closeAsset: Asset) {
        if (mode === "demo") {
          if (!sessionToken) {
            throw new Error("start a session first");
          }
          return post<{ snapshot: EngineSnapshot }>("/api/orders/close", { sessionToken, asset: closeAsset });
        }

        if (closeAsset !== asset) {
          return;
        }

        if (!isVaraReady || !marketSails.data || !account || !onchainPosition) {
          throw new Error("wallet or position is not ready");
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
          const signer = await loadSessionSigner(account.decodedAddress);
          if (!signer) {
            throw new Error("local session signer is unavailable");
          }
          tx.withAccount(signer.pair);
        } else {
          tx.withAccount(account.decodedAddress, { signer: account.signer });
        }
        await tx.calculateGas();
        const result = await tx.signAndSend();
        await result.response();
        refresh();
      }
    }),
    [account, api, asset, hasSessionSigner, isVaraReady, localSessionSigner, marketSails.data, mode, onchainAccount, onchainMarket, onchainPosition, onchainSession, refresh, sessionRegistrySails.data, sessionToken, vaultSails.data]
  );
}
