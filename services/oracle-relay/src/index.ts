import { createPrivateKey, sign } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

const assetSchema = z.enum(["BTC", "ETH", "SOL"]);
type Asset = z.infer<typeof assetSchema>;

const envSchema = z.object({
  VARA_RPC_URL: z.string().url().default("wss://testnet.vara.network"),
  INDEXER_HTTP_URL: z.string().url().default("http://localhost:4301"),
  ORACLE_SERVICE_PROGRAM_ID: z.string().min(1).optional(),
  ORACLE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  PYTH_HERMES_URL: z.string().url().default("https://hermes.pyth.network/v2/updates/price/latest"),
  RELAYER_PRIVATE_KEY_PEM: z.string().optional()
});

const pythResponseSchema = z.object({
  parsed: z.array(
    z.object({
      id: z.string(),
      price: z.object({
        price: z.string(),
        expo: z.number(),
        publish_time: z.number()
      })
    })
  )
});

const FEEDS: Record<Asset, string> = {
  BTC: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  SOL: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"
};

type OracleUpdate = {
  asset: Asset;
  price: number;
  timestamp: number;
  signature?: string;
};

function normalizePrice(rawPrice: string, expo: number): number {
  return Number(rawPrice) * 10 ** expo;
}

async function fetchLatestPrices(baseUrl: string): Promise<OracleUpdate[]> {
  const url = new URL(baseUrl);
  for (const id of Object.values(FEEDS)) {
    url.searchParams.append("ids[]", id);
  }
  url.searchParams.set("parsed", "true");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Pyth Hermes request failed: ${response.status}`);
  }

  const payload = pythResponseSchema.parse(await response.json());
  return payload.parsed.flatMap((entry) => {
    const asset = (Object.entries(FEEDS).find(([, id]) => id === entry.id)?.[0] ?? null) as Asset | null;
    if (!asset) {
      return [];
    }

    return [
      {
        asset,
        price: normalizePrice(entry.price.price, entry.price.expo),
        timestamp: entry.price.publish_time * 1000
      }
    ];
  });
}

function encodeOraclePayload(update: OracleUpdate): Buffer {
  return Buffer.from(`${update.asset}:${update.price}:${update.timestamp}`, "utf8");
}

function signUpdate(update: OracleUpdate, privateKeyPem?: string): OracleUpdate {
  if (!privateKeyPem) {
    return update;
  }

  const privateKey = createPrivateKey(privateKeyPem);
  const signature = sign(null, encodeOraclePayload(update), privateKey).toString("hex");
  return { ...update, signature };
}

async function publishToIndexer(update: OracleUpdate, indexerUrl: string): Promise<void> {
  const response = await fetch(`${indexerUrl}/api/oracle`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      asset: update.asset,
      price: update.price,
      timestamp: update.timestamp,
      signature: update.signature,
      source: "pyth"
    })
  });

  if (!response.ok) {
    throw new Error(`Indexer oracle ingest failed: ${response.status}`);
  }
}

async function main(): Promise<void> {
  const env = envSchema.parse(process.env);
  console.log(`[oracle-relay] starting`, {
    varaRpcUrl: env.VARA_RPC_URL,
    indexerHttpUrl: env.INDEXER_HTTP_URL,
    oracleProgramConfigured: Boolean(env.ORACLE_SERVICE_PROGRAM_ID)
  });

  while (true) {
    try {
      const updates = await fetchLatestPrices(env.PYTH_HERMES_URL);
      for (const update of updates.map((item) => signUpdate(item, env.RELAYER_PRIVATE_KEY_PEM))) {
        await publishToIndexer(update, env.INDEXER_HTTP_URL);
      }
    } catch (error) {
      console.error(`[oracle-relay] cycle failed`, error);
    }

    await sleep(env.ORACLE_POLL_INTERVAL_MS);
  }
}

void main();
