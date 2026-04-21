import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { z } from "zod";

const assetSchema = z.enum(["BTC", "ETH", "SOL"]);
type Asset = z.infer<typeof assetSchema>;

const intervalSchema = z.enum(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d"]);

const envSchema = z.object({
  MARKET_DATA_PROXY_PORT: z.coerce.number().int().positive().default(4302),
  HYPERLIQUID_INFO_URL: z.string().url().default("https://api.hyperliquid.xyz/info"),
  INDEXER_HTTP_URL: z.string().url().default("http://localhost:4301"),
  DEFAULT_INTERVAL: intervalSchema.default("5m"),
  MARKET_REFRESH_INTERVAL_MS: z.coerce.number().int().positive().default(4_000)
});

const candleSchema = z.object({
  t: z.number(),
  T: z.number().optional(),
  c: z.union([z.number(), z.string()]).transform(Number),
  h: z.union([z.number(), z.string()]).transform(Number),
  l: z.union([z.number(), z.string()]).transform(Number),
  o: z.union([z.number(), z.string()]).transform(Number),
  v: z.union([z.number(), z.string()]).optional().transform((value) => (value === undefined ? undefined : Number(value)))
});

const orderBookLevelSchema = z.object({
  px: z.string(),
  sz: z.string(),
  n: z.number().optional()
});

const orderBookResponseSchema = z.object({
  coin: z.string().optional(),
  time: z.number().optional(),
  levels: z.tuple([z.array(orderBookLevelSchema), z.array(orderBookLevelSchema)])
});

type Candle = z.infer<typeof candleSchema>;
type OrderBook = {
  asset: Asset;
  updatedAt: number;
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
};

function respondJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function hyperliquidInfo<T>(infoUrl: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(infoUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Hyperliquid request failed with ${response.status}`);
  }

  return schema.parse(await response.json());
}

async function fetchCandleSnapshot(
  infoUrl: string,
  asset: Asset,
  interval: z.infer<typeof intervalSchema>,
  startTime: number,
  endTime: number
): Promise<Candle[]> {
  return hyperliquidInfo(
    infoUrl,
    {
      type: "candleSnapshot",
      req: {
        coin: asset,
        interval,
        startTime,
        endTime
      }
    },
    z.array(candleSchema)
  );
}

async function fetchAllMids(infoUrl: string): Promise<Record<string, string>> {
  return hyperliquidInfo(infoUrl, { type: "allMids" }, z.record(z.string(), z.string()));
}

async function fetchOrderBook(infoUrl: string, asset: Asset): Promise<OrderBook> {
  const payload = await hyperliquidInfo(
    infoUrl,
    {
      type: "l2Book",
      coin: asset
    },
    orderBookResponseSchema
  );

  return {
    asset,
    updatedAt: payload.time ?? Date.now(),
    bids: payload.levels[0].map((level) => ({ price: Number(level.px), size: Number(level.sz) })),
    asks: payload.levels[1].map((level) => ({ price: Number(level.px), size: Number(level.sz) }))
  };
}

async function publishMarks(indexerUrl: string, marks: Record<string, string>): Promise<void> {
  for (const asset of assetSchema.options) {
    const raw = marks[asset];
    if (!raw) {
      continue;
    }
    await fetch(`${indexerUrl}/api/mark`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        asset,
        price: Number(raw),
        timestamp: Date.now(),
        source: "hyperliquid"
      })
    });
  }
}

async function main(): Promise<void> {
  const env = envSchema.parse(process.env);
  const subscriptions = new Map<WebSocket, { asset: Asset; interval: z.infer<typeof intervalSchema> }>();
  const orderBooks = new Map<Asset, OrderBook>();

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

      const url = new URL(request.url, `http://localhost:${env.MARKET_DATA_PROXY_PORT}`);
      if (request.method === "GET" && url.pathname === "/health") {
        respondJson(response, 200, { ok: true, upstream: env.HYPERLIQUID_INFO_URL });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/candles") {
        const body = z
          .object({
            asset: assetSchema,
            interval: intervalSchema.optional(),
            startTime: z.number(),
            endTime: z.number()
          })
          .parse(await readBody(request));
        const candles = await fetchCandleSnapshot(
          env.HYPERLIQUID_INFO_URL,
          body.asset,
          body.interval ?? env.DEFAULT_INTERVAL,
          body.startTime,
          body.endTime
        );
        respondJson(response, 200, candles);
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/orderbook/")) {
        const asset = assetSchema.parse(url.pathname.split("/").at(-1)?.toUpperCase());
        const cached = orderBooks.get(asset) ?? await fetchOrderBook(env.HYPERLIQUID_INFO_URL, asset);
        orderBooks.set(asset, cached);
        respondJson(response, 200, cached);
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
  ws.on("connection", (socket: WebSocket) => {
    socket.on("message", async (message: RawData) => {
      try {
        const payload = z
          .object({
            asset: assetSchema,
            interval: intervalSchema.optional()
          })
          .parse(JSON.parse(message.toString("utf8")));
        const subscription = {
          asset: payload.asset,
          interval: payload.interval ?? env.DEFAULT_INTERVAL
        };
        subscriptions.set(socket, subscription);

        const endTime = Date.now();
        const startTime = endTime - 1000 * 60 * 60 * 24;
        const [candles, book] = await Promise.all([
          fetchCandleSnapshot(env.HYPERLIQUID_INFO_URL, subscription.asset, subscription.interval, startTime, endTime),
          fetchOrderBook(env.HYPERLIQUID_INFO_URL, subscription.asset)
        ]);
        orderBooks.set(subscription.asset, book);
        socket.send(JSON.stringify({ type: "snapshot", asset: subscription.asset, interval: subscription.interval, candles, orderBook: book }));
      } catch (error) {
        socket.send(
          JSON.stringify({
            type: "error",
            message: error instanceof Error ? error.message : "invalid subscription"
          })
        );
      }
    });

    socket.on("close", () => {
      subscriptions.delete(socket);
    });
  });

  setInterval(async () => {
    try {
      const mids = await fetchAllMids(env.HYPERLIQUID_INFO_URL);
      await publishMarks(env.INDEXER_HTTP_URL, mids);

      for (const asset of assetSchema.options) {
        orderBooks.set(asset, await fetchOrderBook(env.HYPERLIQUID_INFO_URL, asset));
      }

      for (const [socket, subscription] of subscriptions.entries()) {
        if (socket.readyState !== socket.OPEN) {
          subscriptions.delete(socket);
          continue;
        }

        try {
          const endTime = Date.now();
          const startTime = endTime - 1000 * 60 * 60 * 6;
          const candles = await fetchCandleSnapshot(
            env.HYPERLIQUID_INFO_URL,
            subscription.asset,
            subscription.interval,
            startTime,
            endTime
          );
          socket.send(
            JSON.stringify({
              type: "snapshot",
              asset: subscription.asset,
              interval: subscription.interval,
              candles,
              orderBook: orderBooks.get(subscription.asset) ?? null
            })
          );
        } catch (error) {
          socket.send(
            JSON.stringify({
              type: "error",
              message: error instanceof Error ? error.message : "refresh failed"
            })
          );
        }
      }
    } catch (error) {
      console.error(`[market-data-proxy] refresh failed`, error);
    }
  }, env.MARKET_REFRESH_INTERVAL_MS).unref();

  server.listen(env.MARKET_DATA_PROXY_PORT, "127.0.0.1", () => {
    console.log(`[market-data-proxy] listening`, {
      port: env.MARKET_DATA_PROXY_PORT,
      upstream: env.HYPERLIQUID_INFO_URL,
      indexerHttpUrl: env.INDEXER_HTTP_URL
    });
  });
}

void main();
