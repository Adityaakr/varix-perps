export type Asset = "BTC" | "ETH" | "SOL";
export type RuntimeMode = "demo" | "vara";
export type TradeMode = "vara" | "vara-eth";
export type VaraEthExecutionMode = "injected" | "classic";

export type MarketSnapshot = {
  asset: Asset;
  markPrice: string;
  indexPrice: string;
  fundingRateBps: number;
  cumulativeFundingRateBps: number;
  openInterestLong: string;
  openInterestShort: string;
  updatedAt: number;
};

export type PositionSnapshot = {
  id: number;
  trader: string;
  asset: Asset;
  side: "long" | "short";
  size: string;
  notional: string;
  entryPrice: string;
  margin: string;
  leverage: number;
  liquidationPrice: string;
  pnl: string;
  updatedAt: number;
};

export type AccountSnapshot = {
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

export type SessionSnapshot = {
  trader: string;
  name: string;
  createdAt: number;
  sessionToken: string;
};

export type FundingRecord = {
  asset: Asset;
  timestamp: number;
  fundingRateBps: number;
  cumulativeFundingRateBps: number;
};

export type Candle = {
  t: number;
  T?: number;
  c: number;
  h: number;
  l: number;
  o: number;
  v?: number;
};

export type OrderBookLevel = {
  price: number;
  size: number;
};

export type OrderBookSnapshot = {
  asset: Asset;
  updatedAt: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
};

export type RecentTrade = {
  asset: Asset;
  price: number;
  size: number;
  side: "buy" | "sell";
  timestamp: number;
};

export type EngineSnapshot = {
  markets: MarketSnapshot[];
  positions: PositionSnapshot[];
  fundingHistory: FundingRecord[];
  insuranceFund: string;
  liquidityPool: {
    totalLiquidity: string;
    maxOpenNotional: string;
    reservedNotional: string;
  };
  account: AccountSnapshot | null;
  session: SessionSnapshot | null;
};

export type VaraAccountSnapshot = {
  free: bigint;
  locked: bigint;
};

export type VaraLpAccount = {
  shares: bigint;
  deposited: bigint;
};

export type VaraPoolState = {
  total_liquidity: bigint;
  total_shares: bigint;
  reserved_notional: bigint;
  max_capacity: bigint;
};

export type VaraPositionSnapshot = {
  size: bigint;
  entry_price: bigint;
  margin: bigint;
  leverage: number;
  last_funding_rate_bps: bigint;
  opened_at: bigint;
};

export type VaraOpenPositionSnapshot = {
  id: bigint;
  trader: string;
  position: VaraPositionSnapshot;
};

export type VaraMarketSnapshot = {
  mark_price: bigint;
  index_price: bigint;
  funding_rate_bps: bigint;
  cumulative_funding_rate_bps: bigint;
  open_interest_long: bigint;
  open_interest_short: bigint;
};

export type VaraSessionPermissions = {
  trade: boolean;
  add_margin: boolean;
  withdraw: boolean;
};

export type VaraSessionRecord = {
  owner: string;
  session_key: string;
  expires_at: number;
  permissions: VaraSessionPermissions;
  registered_at: number;
};

export type LocalSessionSigner = {
  actorId: string;
  address: string;
  createdAt: number;
};

export type VaraSponsoredVoucher = {
  voucherId: string;
  spender: string;
  programs: string[];
  source: "fresh" | "cached";
  valueVara: string;
  durationBlocks: number;
};

export type VaraSponsoredVoucherBundle = {
  owner: VaraSponsoredVoucher | null;
  session: VaraSponsoredVoucher | null;
};
