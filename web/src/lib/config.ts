const browserHost = typeof window !== "undefined" ? window.location.hostname : "127.0.0.1";

export const INDEXER_HTTP_URL = import.meta.env.VITE_INDEXER_HTTP_URL ?? `http://${browserHost}:4301`;
export const INDEXER_WS_URL = import.meta.env.VITE_INDEXER_WS_URL ?? `ws://${browserHost}:4301`;
export const MARKET_DATA_HTTP_URL = import.meta.env.VITE_MARKET_DATA_HTTP_URL ?? `http://${browserHost}:4302`;
export const MARKET_DATA_WS_URL = import.meta.env.VITE_MARKET_DATA_WS_URL ?? `ws://${browserHost}:4302`;
export const HYPERLIQUID_INFO_URL = import.meta.env.VITE_HYPERLIQUID_INFO_URL ?? "https://api.hyperliquid.xyz/info";
export const HYPERLIQUID_WS_URL = import.meta.env.VITE_HYPERLIQUID_WS_URL ?? "wss://api.hyperliquid.xyz/ws";
export const VARA_RPC_URL = import.meta.env.VITE_NODE_ADDRESS ?? import.meta.env.VITE_VARA_RPC_URL ?? "wss://testnet.vara.network";

export const VARA_DEMO_USDC_PROGRAM_ID =
  import.meta.env.VITE_DEMO_USDC_PROGRAM_ID ?? import.meta.env.VITE_DEMO_USDC_VFT_PROGRAM_ID ?? "";
export const VARA_SESSION_REGISTRY_PROGRAM_ID = import.meta.env.VITE_SESSION_REGISTRY_PROGRAM_ID ?? "";
export const VARA_MARGIN_VAULT_PROGRAM_ID = import.meta.env.VITE_MARGIN_VAULT_PROGRAM_ID ?? "";
export const VARA_LIQUIDITY_POOL_PROGRAM_ID = import.meta.env.VITE_LIQUIDITY_POOL_PROGRAM_ID ?? "";
export const VARA_ORACLE_SERVICE_PROGRAM_ID = import.meta.env.VITE_ORACLE_SERVICE_PROGRAM_ID ?? "";
export const VARA_SESSION_FUNDING_AMOUNT = import.meta.env.VITE_SESSION_FUNDING_AMOUNT ?? "0";
export const VARA_MARKET_PROGRAM_IDS = {
  BTC: import.meta.env.VITE_BTC_MARKET_PROGRAM_ID ?? "",
  ETH: import.meta.env.VITE_ETH_MARKET_PROGRAM_ID ?? "",
  SOL: import.meta.env.VITE_SOL_MARKET_PROGRAM_ID ?? ""
} as const;
export const VARA_SESSION_DURATION_BLOCKS = Number(import.meta.env.VITE_SESSION_DURATION_BLOCKS ?? "1800");

export type RuntimeMode = "demo" | "vara";
export type VaraAsset = keyof typeof VARA_MARKET_PROGRAM_IDS;

const requiredProgramEnv = [
  ["VITE_DEMO_USDC_PROGRAM_ID", VARA_DEMO_USDC_PROGRAM_ID],
  ["VITE_SESSION_REGISTRY_PROGRAM_ID", VARA_SESSION_REGISTRY_PROGRAM_ID],
  ["VITE_MARGIN_VAULT_PROGRAM_ID", VARA_MARGIN_VAULT_PROGRAM_ID],
  ["VITE_LIQUIDITY_POOL_PROGRAM_ID", VARA_LIQUIDITY_POOL_PROGRAM_ID],
  ["VITE_ORACLE_SERVICE_PROGRAM_ID", VARA_ORACLE_SERVICE_PROGRAM_ID]
] as const;

export function getMarketProgramId(asset: VaraAsset) {
  return VARA_MARKET_PROGRAM_IDS[asset];
}

export function getAvailableVaraAssets(): VaraAsset[] {
  return (Object.entries(VARA_MARKET_PROGRAM_IDS) as Array<[VaraAsset, string]>)
    .filter(([, programId]) => Boolean(programId))
    .map(([asset]) => asset);
}

export function getMissingVaraProgramEnvKeys() {
  const missing: string[] = requiredProgramEnv
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (getAvailableVaraAssets().length === 0) {
    missing.push("VITE_BTC_MARKET_PROGRAM_ID | VITE_ETH_MARKET_PROGRAM_ID | VITE_SOL_MARKET_PROGRAM_ID");
  }

  return missing;
}

export function hasVaraPrograms() {
  return getMissingVaraProgramEnvKeys().length === 0;
}

export function getDefaultRuntimeMode(): RuntimeMode {
  return hasVaraPrograms() ? "vara" : "demo";
}
