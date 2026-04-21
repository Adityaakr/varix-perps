import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";

const BPS_DIVISOR = 10_000;
const COLLATERAL_SCALE = 1_000_000;
const PRICE_SCALE = 100_000_000;
const BASE_SCALE = 100_000_000;

const assetSchema = z.enum(["BTC", "ETH", "SOL"]);
type Asset = z.infer<typeof assetSchema>;

const sideSchema = z.enum(["long", "short"]);
type Side = z.infer<typeof sideSchema>;

const envSchema = z.object({
  INDEXER_PORT: z.coerce.number().int().positive().default(4301),
  VARA_RPC_URL: z.string().default("wss://testnet.vara.network"),
  POSTGRES_URL: z.string().default("postgres://varix:varix@localhost:5432/varix"),
  SNAPSHOT_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  FUNDING_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  MAX_FUNDING_RATE_BPS: z.coerce.number().int().positive().default(75),
  INITIAL_COLLATERAL_USDC: z.coerce.number().nonnegative().default(0),
  DEMO_FAUCET_MINT_USDC: z.coerce.number().positive().default(25_000),
  INITIAL_LP_USDC: z.coerce.number().nonnegative().default(100_000),
  LP_NOTIONAL_CAP_MULTIPLIER: z.coerce.number().positive().default(5)
});

const createSessionSchema = z.object({
  name: z.string().trim().min(1).max(32).optional()
});

const sessionActionSchema = z.object({
  sessionToken: z.string().min(16)
});

const balanceActionSchema = sessionActionSchema.extend({
  amount: z.coerce.number().positive()
});

const mintActionSchema = sessionActionSchema.extend({
  amount: z.coerce.number().positive().optional()
});

const lpActionSchema = sessionActionSchema.extend({
  amount: z.coerce.number().positive()
});

const openOrderSchema = sessionActionSchema.extend({
  asset: assetSchema,
  side: sideSchema,
  notional: z.coerce.number().positive(),
  leverage: z.coerce.number().int().min(1).max(20),
  maxSlippageBps: z.coerce.number().int().min(0).max(500)
});

const closeOrderSchema = sessionActionSchema.extend({
  asset: assetSchema
});

const oraclePriceSchema = z.object({
  asset: assetSchema,
  price: z.coerce.number().positive(),
  timestamp: z.coerce.number().int().positive(),
  source: z.string().default("pyth"),
  signature: z.string().optional()
});

const markPriceSchema = z.object({
  asset: assetSchema,
  price: z.coerce.number().positive(),
  timestamp: z.coerce.number().int().positive(),
  source: z.string().default("hyperliquid")
});

const liquidationSchema = z.object({
  asset: assetSchema.optional(),
  trader: z.string().optional()
});

type Session = {
  token: string;
  trader: string;
  name: string;
  createdAt: number;
};

type Account = {
  trader: string;
  walletBalance: bigint;
  freeCollateral: bigint;
  lockedCollateral: bigint;
  totalDeposited: bigint;
  totalWithdrawn: bigint;
  realizedPnl: bigint;
  lpShares: bigint;
};

type Position = {
  trader: string;
  asset: Asset;
  side: Side;
  quantityBase: bigint;
  entryPrice: bigint;
  margin: bigint;
  leverage: number;
  openedAt: number;
  lastFundingRateBps: number;
};

type MarketState = {
  asset: Asset;
  markPrice: bigint;
  indexPrice: bigint;
  fundingRateBps: number;
  cumulativeFundingRateBps: number;
  openInterestLong: bigint;
  openInterestShort: bigint;
  updatedAt: number;
  lastFundingAt: number;
};

type FundingRecord = {
  asset: Asset;
  timestamp: number;
  fundingRateBps: number;
  cumulativeFundingRateBps: number;
};

type FeedRecord = {
  price: bigint;
  timestamp: number;
  source: string;
};

type PositionSnapshot = {
  trader: string;
  asset: Asset;
  side: Side;
  size: string;
  notional: string;
  entryPrice: string;
  margin: string;
  leverage: number;
  liquidationPrice: string;
  pnl: string;
  updatedAt: number;
};

type MarketSnapshot = {
  asset: Asset;
  markPrice: string;
  indexPrice: string;
  fundingRateBps: number;
  cumulativeFundingRateBps: number;
  openInterestLong: string;
  openInterestShort: string;
  updatedAt: number;
};

type AccountSnapshot = {
  trader: string;
  walletBalance: string;
  freeCollateral: string;
  lockedCollateral: string;
  equity: string;
  realizedPnl: string;
  totalDeposited: string;
  totalWithdrawn: string;
  lpShares: string;
};

type SessionSnapshot = {
  trader: string;
  name: string;
  createdAt: number;
  sessionToken: string;
};

type EngineSnapshot = {
  markets: MarketSnapshot[];
  positions: PositionSnapshot[];
  fundingHistory: FundingRecord[];
  insuranceFund: string;
  liquidityPool: {
    totalLiquidity: string;
    maxOpenNotional: string;
  };
  account: AccountSnapshot | null;
  session: SessionSnapshot | null;
};

function toCollateralUnits(amount: number): bigint {
  return BigInt(Math.round(amount * COLLATERAL_SCALE));
}

function toPriceUnits(price: number): bigint {
  return BigInt(Math.round(price * PRICE_SCALE));
}

function fromCollateralUnits(amount: bigint): number {
  return Number(amount) / COLLATERAL_SCALE;
}

function fromPriceUnits(amount: bigint): number {
  return Number(amount) / PRICE_SCALE;
}

function formatCollateral(amount: bigint): string {
  return fromCollateralUnits(amount).toFixed(2);
}

function formatPrice(amount: bigint): string {
  return fromPriceUnits(amount).toFixed(2);
}

function formatBase(amount: bigint): string {
  return (Number(amount) / BASE_SCALE).toFixed(6);
}

function collateralFromBaseAndPrice(quantityBase: bigint, price: bigint): bigint {
  return quantityBase * price / 10_000_000_000n;
}

function signedPnl(position: Position, markPrice: bigint): bigint {
  const signedQuantity = position.side === "long" ? position.quantityBase : -position.quantityBase;
  return signedQuantity * (markPrice - position.entryPrice) / 10_000_000_000n;
}

function maintenanceMargin(notional: bigint): bigint {
  return notional * 600n / BigInt(BPS_DIVISOR);
}

function clampFundingRate(markPrice: bigint, indexPrice: bigint, maxFundingRateBps: number): number {
  if (indexPrice <= 0n) {
    return 0;
  }

  const premiumBps = Number((markPrice - indexPrice) * BigInt(BPS_DIVISOR) / indexPrice);
  return Math.max(-maxFundingRateBps, Math.min(maxFundingRateBps, premiumBps));
}

function traderHandle(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

class Engine {
  private readonly sessions = new Map<string, Session>();
  private readonly accounts = new Map<string, Account>();
  private readonly positions = new Map<string, Position>();
  private readonly markets = new Map<Asset, MarketState>();
  private readonly fundingHistory: FundingRecord[] = [];
  private readonly indexFeed = new Map<Asset, FeedRecord>();
  private readonly markFeed = new Map<Asset, FeedRecord>();
  private insuranceFund = 0n;
  private liquidityPoolBalance = 0n;
  private totalLpShares = 0n;

  constructor(private readonly env: z.infer<typeof envSchema>) {
    const now = Date.now();
    this.liquidityPoolBalance = toCollateralUnits(env.INITIAL_LP_USDC);
    this.totalLpShares = this.liquidityPoolBalance;
    for (const asset of assetSchema.options) {
      this.markets.set(asset, {
        asset,
        markPrice: 0n,
        indexPrice: 0n,
        fundingRateBps: 0,
        cumulativeFundingRateBps: 0,
        openInterestLong: 0n,
        openInterestShort: 0n,
        updatedAt: now,
        lastFundingAt: now
      });
    }
  }

  createSession(name?: string): SessionSnapshot {
    const token = randomUUID().replaceAll("-", "");
    const trader = traderHandle(token);
    const session: Session = {
      token,
      trader,
      name: name?.trim() || `Trader ${this.sessions.size + 1}`,
      createdAt: Date.now()
    };
    const initialCollateral = toCollateralUnits(this.env.INITIAL_COLLATERAL_USDC);
    this.sessions.set(token, session);
    this.accounts.set(trader, {
      trader,
      walletBalance: initialCollateral,
      freeCollateral: initialCollateral,
      lockedCollateral: 0n,
      totalDeposited: initialCollateral,
      totalWithdrawn: 0n,
      realizedPnl: 0n,
      lpShares: 0n
    });
    return {
      trader,
      name: session.name,
      createdAt: session.createdAt,
      sessionToken: session.token
    };
  }

  deposit(sessionToken: string, amount: number): AccountSnapshot {
    const account = this.requireAccount(sessionToken);
    const delta = toCollateralUnits(amount);
    if (account.walletBalance < delta) {
      throw new Error("insufficient demo token balance");
    }
    account.walletBalance -= delta;
    account.freeCollateral += delta;
    account.totalDeposited += delta;
    return this.accountSnapshot(account.trader);
  }

  withdraw(sessionToken: string, amount: number): AccountSnapshot {
    const account = this.requireAccount(sessionToken);
    const delta = toCollateralUnits(amount);
    if (account.freeCollateral < delta) {
      throw new Error("insufficient free collateral");
    }
    account.freeCollateral -= delta;
    account.walletBalance += delta;
    account.totalWithdrawn += delta;
    return this.accountSnapshot(account.trader);
  }

  mintDemoTokens(sessionToken: string, amount?: number): AccountSnapshot {
    const account = this.requireAccount(sessionToken);
    const delta = toCollateralUnits(amount ?? this.env.DEMO_FAUCET_MINT_USDC);
    account.walletBalance += delta;
    return this.accountSnapshot(account.trader);
  }

  provideLiquidity(sessionToken: string, amount: number): { account: AccountSnapshot; pool: EngineSnapshot["liquidityPool"] } {
    const account = this.requireAccount(sessionToken);
    const delta = toCollateralUnits(amount);
    if (account.walletBalance < delta) {
      throw new Error("insufficient demo token balance");
    }

    account.walletBalance -= delta;
    account.lpShares += delta;
    this.liquidityPoolBalance += delta;
    this.totalLpShares += delta;

    return {
      account: this.accountSnapshot(account.trader),
      pool: this.poolSnapshot()
    };
  }

  openPosition(input: z.infer<typeof openOrderSchema>): PositionSnapshot {
    const session = this.requireSession(input.sessionToken);
    const market = this.requireMarket(input.asset);
    const account = this.requireAccount(input.sessionToken);
    const positionKey = this.positionKey(session.trader, input.asset);

    if (this.positions.has(positionKey)) {
      throw new Error("position already exists for trader and asset");
    }
    if (market.markPrice <= 0n || market.indexPrice <= 0n) {
      throw new Error("market has no live price");
    }

    const notional = toCollateralUnits(input.notional);
    const margin = notional / BigInt(input.leverage);
    if (margin <= 0n) {
      throw new Error("invalid margin");
    }
    if (account.freeCollateral < margin) {
      throw new Error("insufficient collateral");
    }
    if (this.liquidityPoolBalance <= 0n) {
      throw new Error("liquidity pool is empty");
    }
    if (this.totalOpenNotional() + notional > this.maxOpenNotional()) {
      throw new Error("notional exceeds available liquidity capacity");
    }

    const quantityBase = notional * 10_000_000_000n / market.markPrice;
    const slippageBps = Math.min(input.maxSlippageBps, 250);
    const fillPrice =
      input.side === "long"
        ? market.markPrice * BigInt(BPS_DIVISOR + slippageBps) / BigInt(BPS_DIVISOR)
        : market.markPrice * BigInt(BPS_DIVISOR - slippageBps) / BigInt(BPS_DIVISOR);

    const position: Position = {
      trader: session.trader,
      asset: input.asset,
      side: input.side,
      quantityBase,
      entryPrice: fillPrice,
      margin,
      leverage: input.leverage,
      openedAt: Date.now(),
      lastFundingRateBps: market.cumulativeFundingRateBps
    };

    this.positions.set(positionKey, position);
    account.freeCollateral -= margin;
    account.lockedCollateral += margin;
    this.refreshOpenInterest(input.asset);
    return this.positionSnapshot(position);
  }

  closePosition(sessionToken: string, asset: Asset): { account: AccountSnapshot; position: PositionSnapshot } {
    const session = this.requireSession(sessionToken);
    const account = this.requireAccount(sessionToken);
    const key = this.positionKey(session.trader, asset);
    const position = this.positions.get(key);
    if (!position) {
      throw new Error("position not found");
    }
    const market = this.requireMarket(asset);
    const pnl = this.positionPnl(position);
    const settledFunding = this.fundingDelta(position, market);
    const released = position.margin + pnl - settledFunding;
    this.liquidityPoolBalance -= pnl - settledFunding;
    account.lockedCollateral -= position.margin;
    if (released >= 0n) {
      account.freeCollateral += released;
      account.realizedPnl += pnl - settledFunding;
    } else {
      account.realizedPnl += pnl - settledFunding;
      this.insuranceFund += -released;
    }
    this.positions.delete(key);
    this.refreshOpenInterest(asset);
    return {
      account: this.accountSnapshot(session.trader),
      position: this.positionSnapshot(position)
    };
  }

  submitIndexPrice(input: z.infer<typeof oraclePriceSchema>): MarketSnapshot {
    const price = toPriceUnits(input.price);
    this.indexFeed.set(input.asset, { price, timestamp: input.timestamp, source: input.source });
    const market = this.requireMarket(input.asset);
    if (input.timestamp >= market.updatedAt) {
      market.indexPrice = price;
      if (market.markPrice === 0n) {
        market.markPrice = price;
      }
      market.updatedAt = input.timestamp;
      market.fundingRateBps = clampFundingRate(market.markPrice, market.indexPrice, this.env.MAX_FUNDING_RATE_BPS);
    }
    return this.marketSnapshot(input.asset);
  }

  submitMarkPrice(input: z.infer<typeof markPriceSchema>): MarketSnapshot {
    const price = toPriceUnits(input.price);
    this.markFeed.set(input.asset, { price, timestamp: input.timestamp, source: input.source });
    const market = this.requireMarket(input.asset);
    if (input.timestamp >= market.updatedAt || market.markPrice === 0n) {
      market.markPrice = price;
      if (market.indexPrice === 0n) {
        market.indexPrice = price;
      }
      market.updatedAt = input.timestamp;
      market.fundingRateBps = clampFundingRate(market.markPrice, market.indexPrice, this.env.MAX_FUNDING_RATE_BPS);
      this.refreshOpenInterest(input.asset);
    }
    return this.marketSnapshot(input.asset);
  }

  runFunding(): FundingRecord[] {
    const now = Date.now();
    const records: FundingRecord[] = [];

    for (const market of this.markets.values()) {
      if (now - market.lastFundingAt < this.env.FUNDING_INTERVAL_MS) {
        continue;
      }

      market.lastFundingAt = now;
      market.fundingRateBps = clampFundingRate(market.markPrice, market.indexPrice, this.env.MAX_FUNDING_RATE_BPS);
      market.cumulativeFundingRateBps += market.fundingRateBps;
      const record: FundingRecord = {
        asset: market.asset,
        timestamp: now,
        fundingRateBps: market.fundingRateBps,
        cumulativeFundingRateBps: market.cumulativeFundingRateBps
      };
      this.fundingHistory.unshift(record);
      records.push(record);

      for (const position of this.positions.values()) {
        if (position.asset !== market.asset) {
          continue;
        }
        const fundingDelta = this.fundingDelta(position, market);
        position.margin -= fundingDelta;
        position.lastFundingRateBps = market.cumulativeFundingRateBps;
      }

      this.runLiquidations({ asset: market.asset });
    }

    return records;
  }

  runLiquidations(filter: z.infer<typeof liquidationSchema>): PositionSnapshot[] {
    const liquidated: PositionSnapshot[] = [];
    for (const position of [...this.positions.values()]) {
      if (filter.asset && position.asset !== filter.asset) {
        continue;
      }
      if (filter.trader && position.trader !== filter.trader) {
        continue;
      }

      const market = this.requireMarket(position.asset);
      const pnl = this.positionPnl(position);
      const funding = this.fundingDelta(position, market);
      const notional = collateralFromBaseAndPrice(position.quantityBase, market.markPrice);
      const equity = position.margin + pnl - funding;
      if (equity > maintenanceMargin(notional)) {
        continue;
      }

      const account = this.accounts.get(position.trader);
      if (account) {
        account.lockedCollateral -= position.margin;
        this.liquidityPoolBalance += position.margin;
        if (equity > 0n) {
          const rebate = equity / 2n;
          account.freeCollateral += rebate;
          this.insuranceFund += equity - rebate;
          this.liquidityPoolBalance -= rebate;
        } else {
          this.insuranceFund += position.margin;
        }
      }
      this.positions.delete(this.positionKey(position.trader, position.asset));
      this.refreshOpenInterest(position.asset);
      liquidated.push(this.positionSnapshot(position));
    }
    return liquidated;
  }

  snapshot(sessionToken?: string | null): EngineSnapshot {
    const session = sessionToken ? this.sessions.get(sessionToken) ?? null : null;
    const positions = session
      ? [...this.positions.values()].filter((position) => position.trader === session.trader)
      : [...this.positions.values()];
    return {
      markets: [...this.markets.keys()].map((asset) => this.marketSnapshot(asset)),
      positions: positions.map((position) => this.positionSnapshot(position)),
      fundingHistory: this.fundingHistory.slice(0, 24),
      insuranceFund: formatCollateral(this.insuranceFund),
      liquidityPool: this.poolSnapshot(),
      account: session ? this.accountSnapshot(session.trader) : null,
      session: session
        ? {
            trader: session.trader,
            name: session.name,
            createdAt: session.createdAt,
            sessionToken: session.token
          }
        : null
    };
  }

  marketSnapshot(asset: Asset): MarketSnapshot {
    const market = this.requireMarket(asset);
    return {
      asset,
      markPrice: formatPrice(market.markPrice),
      indexPrice: formatPrice(market.indexPrice),
      fundingRateBps: market.fundingRateBps,
      cumulativeFundingRateBps: market.cumulativeFundingRateBps,
      openInterestLong: formatCollateral(market.openInterestLong),
      openInterestShort: formatCollateral(market.openInterestShort),
      updatedAt: market.updatedAt
    };
  }

  accountSnapshot(trader: string): AccountSnapshot {
    const account = this.accounts.get(trader);
    if (!account) {
      throw new Error("account not found");
    }
    const positions = [...this.positions.values()].filter((position) => position.trader === trader);
    const equity = positions.reduce((total, position) => total + position.margin + this.positionPnl(position), account.freeCollateral);
    return {
      trader,
      walletBalance: formatCollateral(account.walletBalance),
      freeCollateral: formatCollateral(account.freeCollateral),
      lockedCollateral: formatCollateral(account.lockedCollateral),
      equity: formatCollateral(equity),
      realizedPnl: formatCollateral(account.realizedPnl),
      totalDeposited: formatCollateral(account.totalDeposited),
      totalWithdrawn: formatCollateral(account.totalWithdrawn),
      lpShares: formatCollateral(account.lpShares)
    };
  }

  positionSnapshot(position: Position): PositionSnapshot {
    const market = this.requireMarket(position.asset);
    const notional = collateralFromBaseAndPrice(position.quantityBase, market.markPrice);
    return {
      trader: position.trader,
      asset: position.asset,
      side: position.side,
      size: formatBase(position.quantityBase),
      notional: formatCollateral(notional),
      entryPrice: formatPrice(position.entryPrice),
      margin: formatCollateral(position.margin),
      leverage: position.leverage,
      liquidationPrice: formatPrice(this.liquidationPrice(position)),
      pnl: formatCollateral(this.positionPnl(position)),
      updatedAt: market.updatedAt
    };
  }

  private requireSession(token: string): Session {
    const session = this.sessions.get(token);
    if (!session) {
      throw new Error("invalid session token");
    }
    return session;
  }

  private requireAccount(token: string): Account {
    const session = this.requireSession(token);
    const account = this.accounts.get(session.trader);
    if (!account) {
      throw new Error("account not found");
    }
    return account;
  }

  private requireMarket(asset: Asset): MarketState {
    const market = this.markets.get(asset);
    if (!market) {
      throw new Error("market not found");
    }
    return market;
  }

  private positionKey(trader: string, asset: Asset): string {
    return `${trader}:${asset}`;
  }

  private positionPnl(position: Position): bigint {
    return signedPnl(position, this.requireMarket(position.asset).markPrice);
  }

  private fundingDelta(position: Position, market: MarketState): bigint {
    const rateDelta = BigInt(market.cumulativeFundingRateBps - position.lastFundingRateBps);
    if (rateDelta === 0n) {
      return 0n;
    }
    const notional = collateralFromBaseAndPrice(position.quantityBase, market.markPrice);
    const payment = notional * rateDelta / BigInt(BPS_DIVISOR);
    return position.side === "long" ? payment : -payment;
  }

  private liquidationPrice(position: Position): bigint {
    const mmBps = 600n;
    const q = position.quantityBase;
    const entryTerm = q * position.entryPrice / 10_000_000_000n;
    if (position.side === "long") {
      const numerator = entryTerm - position.margin;
      const denominator = q * BigInt(BPS_DIVISOR) / BigInt(BPS_DIVISOR) * (BigInt(BPS_DIVISOR) - mmBps);
      if (denominator <= 0n) {
        return 0n;
      }
      const price = numerator * 10_000_000_000n / (q * (BigInt(BPS_DIVISOR) - mmBps) / BigInt(BPS_DIVISOR));
      return price > 0n ? price : 0n;
    }

    const numerator = position.margin + entryTerm;
    const price = numerator * 10_000_000_000n / (q * (BigInt(BPS_DIVISOR) + mmBps) / BigInt(BPS_DIVISOR));
    return price > 0n ? price : 0n;
  }

  private refreshOpenInterest(asset: Asset): void {
    const market = this.requireMarket(asset);
    let longOi = 0n;
    let shortOi = 0n;
    for (const position of this.positions.values()) {
      if (position.asset !== asset) {
        continue;
      }
      const notional = collateralFromBaseAndPrice(position.quantityBase, market.markPrice);
      if (position.side === "long") {
        longOi += notional;
      } else {
        shortOi += notional;
      }
    }
    market.openInterestLong = longOi;
    market.openInterestShort = shortOi;
  }

  private totalOpenNotional(): bigint {
    let total = 0n;
    for (const position of this.positions.values()) {
      total += collateralFromBaseAndPrice(position.quantityBase, this.requireMarket(position.asset).markPrice);
    }
    return total;
  }

  private maxOpenNotional(): bigint {
    return this.liquidityPoolBalance * BigInt(this.env.LP_NOTIONAL_CAP_MULTIPLIER);
  }

  private poolSnapshot(): EngineSnapshot["liquidityPool"] {
    return {
      totalLiquidity: formatCollateral(this.liquidityPoolBalance),
      maxOpenNotional: formatCollateral(this.maxOpenNotional())
    };
  }
}

function respondJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function broadcast(clients: Map<WebSocket, string | undefined>, engine: Engine): void {
  for (const [client, sessionToken] of clients) {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(engine.snapshot(sessionToken)));
    }
  }
}

async function main(): Promise<void> {
  const env = envSchema.parse(process.env);
  const engine = new Engine(env);
  const clients = new Map<WebSocket, string | undefined>();

  const server = createServer(async (request, response) => {
    try {
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type"
        });
        response.end();
        return;
      }

      if (!request.url) {
        respondJson(response, 400, { error: "missing url" });
        return;
      }

      const url = new URL(request.url, `http://localhost:${env.INDEXER_PORT}`);

      if (request.method === "GET" && url.pathname === "/health") {
        respondJson(response, 200, {
          ok: true,
          varaRpcUrl: env.VARA_RPC_URL,
          postgresConfigured: Boolean(env.POSTGRES_URL)
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/state") {
        const sessionToken = url.searchParams.get("sessionToken");
        respondJson(response, 200, engine.snapshot(sessionToken));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/markets") {
        respondJson(response, 200, engine.snapshot().markets);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/session") {
        const body = createSessionSchema.parse(await readJson(request));
        const session = engine.createSession(body.name);
        respondJson(response, 201, {
          session,
          snapshot: engine.snapshot(session.sessionToken)
        });
        broadcast(clients, engine);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/account/deposit") {
        const body = balanceActionSchema.parse(await readJson(request));
        respondJson(response, 200, {
          account: engine.deposit(body.sessionToken, body.amount),
          snapshot: engine.snapshot(body.sessionToken)
        });
        broadcast(clients, engine);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/demo-token/mint") {
        const body = mintActionSchema.parse(await readJson(request));
        respondJson(response, 200, {
          account: engine.mintDemoTokens(body.sessionToken, body.amount),
          snapshot: engine.snapshot(body.sessionToken)
        });
        broadcast(clients, engine);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/account/withdraw") {
        const body = balanceActionSchema.parse(await readJson(request));
        respondJson(response, 200, {
          account: engine.withdraw(body.sessionToken, body.amount),
          snapshot: engine.snapshot(body.sessionToken)
        });
        broadcast(clients, engine);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/liquidity/provide") {
        const body = lpActionSchema.parse(await readJson(request));
        respondJson(response, 200, {
          result: engine.provideLiquidity(body.sessionToken, body.amount),
          snapshot: engine.snapshot(body.sessionToken)
        });
        broadcast(clients, engine);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/orders/open") {
        const body = openOrderSchema.parse(await readJson(request));
        respondJson(response, 200, {
          position: engine.openPosition(body),
          snapshot: engine.snapshot(body.sessionToken)
        });
        broadcast(clients, engine);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/orders/close") {
        const body = closeOrderSchema.parse(await readJson(request));
        respondJson(response, 200, {
          result: engine.closePosition(body.sessionToken, body.asset),
          snapshot: engine.snapshot(body.sessionToken)
        });
        broadcast(clients, engine);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/oracle") {
        const body = oraclePriceSchema.parse(await readJson(request));
        respondJson(response, 202, {
          market: engine.submitIndexPrice(body),
          snapshot: engine.snapshot()
        });
        broadcast(clients, engine);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/mark") {
        const body = markPriceSchema.parse(await readJson(request));
        respondJson(response, 202, {
          market: engine.submitMarkPrice(body),
          snapshot: engine.snapshot()
        });
        broadcast(clients, engine);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/liquidations/check") {
        const body = liquidationSchema.parse(await readJson(request));
        const liquidated = engine.runLiquidations(body);
        respondJson(response, 200, {
          liquidated,
          snapshot: engine.snapshot()
        });
        broadcast(clients, engine);
        return;
      }

      respondJson(response, 404, { error: "not found" });
    } catch (error) {
      respondJson(response, 400, {
        error: error instanceof Error ? error.message : "request failed"
      });
    }
  });

  const ws = new WebSocketServer({ server });
  ws.on("connection", (socket: WebSocket, request) => {
    const url = request.url ? new URL(request.url, `http://localhost:${env.INDEXER_PORT}`) : null;
    const sessionToken = url?.searchParams.get("sessionToken") ?? undefined;
    clients.set(socket, sessionToken);
    socket.send(JSON.stringify(engine.snapshot(sessionToken)));
    socket.on("close", () => {
      clients.delete(socket);
    });
  });

  setInterval(() => {
    engine.runFunding();
    broadcast(clients, engine);
  }, Math.max(5_000, env.FUNDING_INTERVAL_MS / 2)).unref();

  setInterval(() => {
    broadcast(clients, engine);
  }, env.SNAPSHOT_INTERVAL_MS).unref();

  server.listen(env.INDEXER_PORT, "127.0.0.1", () => {
    console.log(`[indexer] listening`, {
      port: env.INDEXER_PORT,
      varaRpcUrl: env.VARA_RPC_URL,
      fundingIntervalMs: env.FUNDING_INTERVAL_MS
    });
  });
}

void main();
