import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";

type Env = {
  port: number;
  rpcUrl: string;
  walletBin: string;
  sponsorAccount: string;
  minNativeBalance: string;
  voucherValue: string;
  voucherDurationBlocks: number;
};

type VoucherRequest = {
  owner: string;
  session?: string;
  ownerPrograms: string[];
  sessionPrograms: string[];
};

type VoucherRecord = {
  voucherId: string;
  spender: string;
  programs: string[];
  source: "fresh" | "cached";
  valueVara: string;
  durationBlocks: number;
};

function envString(name: string, fallback: string) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function envNumber(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid ${name}: expected a positive number`);
  }
  return Math.trunc(parsed);
}

function parseEnv(): Env {
  return {
    port: envNumber("VARA_VOUCHER_SPONSOR_PORT", 4317),
    rpcUrl: envString("VARA_RPC_URL", "wss://testnet.vara.network"),
    walletBin: envString("VARA_WALLET_BIN", "vara-wallet"),
    sponsorAccount: envString("VARA_VOUCHER_SPONSOR_ACCOUNT", "agent100"),
    minNativeBalance: envString("VARA_SPONSOR_MIN_NATIVE_BALANCE", "10"),
    voucherValue: envString("VARA_VOUCHER_VALUE", "50"),
    voucherDurationBlocks: envNumber("VARA_VOUCHER_DURATION_BLOCKS", 14_400)
  };
}

function isActorId(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);
}

function isVaraAddress(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  return isActorId(value) || /^[1-9A-HJ-NP-Za-km-z]{20,64}$/.test(value);
}

function parsePrograms(input: unknown, label: string) {
  if (!Array.isArray(input)) {
    throw new Error(`${label} must be an array`);
  }

  return input.map((program, index) => {
    if (!isActorId(program)) {
      throw new Error(`${label}[${index}] must be a 32-byte hex actor id`);
    }
    return program;
  });
}

function parseVoucherRequest(raw: unknown): VoucherRequest {
  if (!raw || typeof raw !== "object") {
    throw new Error("request body must be an object");
  }

  const payload = raw as Record<string, unknown>;
  if (!isVaraAddress(payload.owner)) {
    throw new Error("owner must be a Vara address");
  }
  if (payload.session !== undefined && !isVaraAddress(payload.session)) {
    throw new Error("session must be a Vara address");
  }

  const request: VoucherRequest = {
    owner: payload.owner,
    ownerPrograms: parsePrograms(payload.ownerPrograms ?? [], "ownerPrograms"),
    sessionPrograms: parsePrograms(payload.sessionPrograms ?? [], "sessionPrograms")
  };
  if (payload.session !== undefined) {
    request.session = payload.session;
  }
  return request;
}

const env = parseEnv();
const voucherCache = new Map<string, VoucherRecord>();

function json(status: number, payload: unknown) {
  return {
    status,
    headers: {
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-origin": "*",
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  };
}

function sortedPrograms(programs: string[]) {
  return [...new Set(programs.map((program) => program.toLowerCase()))].sort();
}

function cacheKey(spender: string, programs: string[]) {
  return `${spender.toLowerCase()}::${sortedPrograms(programs).join(",")}`;
}

function runWallet(args: string[]) {
  const walletIsJsEntrypoint = env.walletBin.endsWith(".js");
  const command = walletIsJsEntrypoint ? "node" : env.walletBin;
  const sharedArgs = [
    "--ws",
    env.rpcUrl,
    "--account",
    env.sponsorAccount,
    "--json"
  ];
  const commandArgs = walletIsJsEntrypoint
    ? [env.walletBin, ...sharedArgs, ...args]
    : [...sharedArgs, ...args];

  const output = execFileSync(command, commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();

  return output ? JSON.parse(output) as Record<string, unknown> : {};
}

function issueVoucher(spender: string, programs: string[]): VoucherRecord {
  const normalizedPrograms = sortedPrograms(programs);
  const id = cacheKey(spender, normalizedPrograms);
  const cached = voucherCache.get(id);
  if (cached) {
    return { ...cached, source: "cached" };
  }

  const args = [
    "voucher",
    "issue",
    spender,
    env.voucherValue,
    "--duration",
    String(env.voucherDurationBlocks)
  ];
  if (normalizedPrograms.length > 0) {
    args.push("--programs", normalizedPrograms.join(","));
  }

  const result = runWallet(args);
  const voucherId = typeof result.voucherId === "string" ? result.voucherId : null;
  if (!voucherId) {
    throw new Error("sponsor did not return a voucherId");
  }

  const issued: VoucherRecord = {
    voucherId,
    spender,
    programs: normalizedPrograms,
    source: "fresh",
    valueVara: env.voucherValue,
    durationBlocks: env.voucherDurationBlocks
  };
  voucherCache.set(id, issued);
  return issued;
}

function ensureNativeBalance(address: string) {
  const balance = runWallet(["balance", address]);
  const balanceRaw = BigInt(typeof balance.balanceRaw === "string" ? balance.balanceRaw : "0");
  if (balanceRaw > 0n) {
    return;
  }

  runWallet(["transfer", address, env.minNativeBalance]);
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleEnsure(body: string) {
  const payload = parseVoucherRequest(JSON.parse(body || "{}"));
  ensureNativeBalance(payload.owner);
  const owner = issueVoucher(payload.owner, payload.ownerPrograms);
  const session = payload.session
    ? (ensureNativeBalance(payload.session), issueVoucher(payload.session, payload.sessionPrograms))
    : null;

  return json(200, { owner, session });
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      const result = json(204, {});
      response.writeHead(result.status, result.headers);
      response.end();
      return;
    }

    if (request.method === "GET" && request.url === "/api/health") {
      const result = json(200, {
        ok: true,
        rpcUrl: env.rpcUrl,
        sponsorAccount: env.sponsorAccount,
        cachedVouchers: voucherCache.size
      });
      response.writeHead(result.status, result.headers);
      response.end(result.body);
      return;
    }

    if (request.method === "POST" && request.url === "/api/vouchers/ensure") {
      const result = await handleEnsure(await readBody(request));
      response.writeHead(result.status, result.headers);
      response.end(result.body);
      return;
    }

    const result = json(404, { error: "not found" });
    response.writeHead(result.status, result.headers);
    response.end(result.body);
  } catch (error) {
    console.error("[voucher-sponsor] request failed", error);
    const result = json(500, {
      error: error instanceof Error ? error.message : "unknown sponsor error"
    });
    response.writeHead(result.status, result.headers);
    response.end(result.body);
  }
});

server.listen(env.port, () => {
  console.log("[voucher-sponsor] listening", {
    port: env.port,
    rpcUrl: env.rpcUrl,
    sponsorAccount: env.sponsorAccount
  });
});
