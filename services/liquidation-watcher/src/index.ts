import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

const envSchema = z.object({
  INDEXER_HTTP_URL: z.string().url().default("http://localhost:4301"),
  VARA_RPC_URL: z.string().default("wss://testnet.vara.network"),
  LIQUIDATION_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3_000)
});

const positionSchema = z.object({
  trader: z.string(),
  asset: z.enum(["BTC", "ETH", "SOL"]),
  side: z.enum(["long", "short"]),
  size: z.string(),
  notional: z.string(),
  entryPrice: z.string(),
  margin: z.string(),
  leverage: z.number().int().positive(),
  liquidationPrice: z.string(),
  pnl: z.string(),
  updatedAt: z.number()
});

const stateSchema = z.object({
  positions: z.array(positionSchema)
});

type Position = z.infer<typeof positionSchema>;

async function fetchOpenPositions(indexerUrl: string): Promise<Position[]> {
  const response = await fetch(`${indexerUrl}/api/state`);
  if (!response.ok) {
    throw new Error(`Indexer request failed: ${response.status}`);
  }
  return stateSchema.parse(await response.json()).positions;
}

function isLiquidatable(position: Position): boolean {
  return Number(position.liquidationPrice) > 0 && Math.abs(Number(position.pnl)) >= Number(position.margin) * 0.94;
}

async function submitLiquidation(position: Position, indexerUrl: string, varaRpcUrl: string): Promise<void> {
  const response = await fetch(`${indexerUrl}/api/liquidations/check`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      trader: position.trader,
      asset: position.asset
    })
  });

  if (!response.ok) {
    throw new Error(`Liquidation request failed: ${response.status}`);
  }

  console.log(`[liquidation-watcher] liquidation check submitted`, {
    trader: position.trader,
    asset: position.asset,
    varaRpcUrl
  });
}

async function main(): Promise<void> {
  const env = envSchema.parse(process.env);
  console.log(`[liquidation-watcher] starting`, env);

  while (true) {
    try {
      const positions = await fetchOpenPositions(env.INDEXER_HTTP_URL);
      for (const position of positions) {
        if (isLiquidatable(position)) {
          await submitLiquidation(position, env.INDEXER_HTTP_URL, env.VARA_RPC_URL);
        }
      }
    } catch (error) {
      console.error(`[liquidation-watcher] cycle failed`, error);
    }

    await sleep(env.LIQUIDATION_POLL_INTERVAL_MS);
  }
}

void main();
