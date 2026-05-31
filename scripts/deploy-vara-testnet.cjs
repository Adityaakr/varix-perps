const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const rootDir = process.cwd();

const WS = process.env.VARA_TESTNET_WS || "wss://testnet.vara.network";
const MAX_GAS_LIMIT = process.env.VARA_GAS_LIMIT || "750000000000";
const VARA_WALLET_BIN = process.env.VARA_WALLET_BIN || "vara-wallet";
const VARA_ACCOUNT = process.env.VARA_WALLET_ACCOUNT || "";
const DEPLOY_ALL_MARKETS = process.env.VARA_DEPLOY_ALL_MARKETS === "1";
const AUTHORIZE_MARKETS = process.env.VARA_AUTHORIZE_MARKETS !== "0";
const OUTPUT_ENV_PATH = process.env.VARA_ENV_OUTPUT_PATH || path.join("web", ".env.testnet.local");
const SALT_SUFFIX = process.env.VARA_DEPLOY_SALT_SUFFIX?.trim() || "";

function here(...parts) {
  return path.join(rootDir, ...parts);
}

function saltHex(label) {
  return `0x${Buffer.from(label, "utf8").toString("hex")}`;
}

function scopedSalt(label) {
  return SALT_SUFFIX ? `${label}-${SALT_SUFFIX}` : label;
}

function ensureFile(filePath) {
  if (fs.existsSync(filePath)) {
    return filePath;
  }

  throw new Error(
    `missing required artifact: ${path.relative(rootDir, filePath)}\n` +
      "Build the Vara contracts first, for example:\n" +
      "  pnpm build:local-vara-contracts"
  );
}

function runWallet(args) {
  const walletIsJsEntrypoint = VARA_WALLET_BIN.endsWith(".js");
  const command = walletIsJsEntrypoint ? "node" : VARA_WALLET_BIN;
  const sharedArgs = ["--ws", WS, "--account", VARA_ACCOUNT, "--json"];
  const commandArgs = walletIsJsEntrypoint
    ? [VARA_WALLET_BIN, ...sharedArgs, ...args]
    : [...sharedArgs, ...args];

  try {
    const output = execFileSync(command, commandArgs, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    return output ? JSON.parse(output) : null;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(
        `vara-wallet CLI was not found (${VARA_WALLET_BIN}). Install it with 'npm install -g vara-wallet' ` +
          "or set VARA_WALLET_BIN to the executable path."
      );
    }

    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : "";
    const stdout = error && typeof error === "object" && "stdout" in error ? String(error.stdout).trim() : "";
    throw new Error(stderr || stdout || "vara-wallet command failed");
  }
}

function requireAccount() {
  if (!VARA_ACCOUNT) {
    throw new Error(
      "set VARA_WALLET_ACCOUNT to the vara-wallet account name you want to deploy with"
    );
  }
}

function resolveDeployer() {
  const balance = runWallet(["balance"]);
  if (!balance?.address) {
    throw new Error(`failed to resolve deployer address for account '${VARA_ACCOUNT}'`);
  }
  if (BigInt(balance.balanceRaw ?? "0") <= 0n) {
    throw new Error(
      `account '${VARA_ACCOUNT}' has 0 TVARA on ${WS}. Fund it first, for example:\n` +
        `  vara-wallet --ws ${WS} --account ${VARA_ACCOUNT} faucet`
    );
  }
  return {
    actorId: balance.address,
    ss58: balance.addressSS58,
    balanceRaw: balance.balanceRaw
  };
}

function uploadProgram({ label, wasm, idl, init, args, salt }) {
  console.log(`uploading ${label}`);
  const result = runWallet([
    "program",
    "upload",
    ensureFile(wasm),
    "--idl",
    ensureFile(idl),
    "--init",
    init,
    "--args",
    JSON.stringify(args),
    "--salt",
    saltHex(scopedSalt(salt)),
    "--gas-limit",
    MAX_GAS_LIMIT
  ]);
  console.log(`uploaded ${label}: ${result.programId}`);
  return result;
}

function callFunction(programId, idlPath, method, args) {
  console.log(`calling ${method} on ${programId}`);
  return runWallet([
    "call",
    programId,
    method,
    "--idl",
    ensureFile(idlPath),
    "--args",
    JSON.stringify(args ?? []),
    "--gas-limit",
    MAX_GAS_LIMIT
  ]);
}

function writeEnvFile(envLines) {
  const absolutePath = here(OUTPUT_ENV_PATH);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${envLines.join("\n")}\n`, "utf8");
  return absolutePath;
}

async function main() {
  requireAccount();
  const deployer = resolveDeployer();
  const deployed = {};

  deployed.sessionRegistry = uploadProgram({
    label: "session-registry",
    wasm: here("contracts", "session-registry", "target", "wasm32-gear", "debug", "session_registry.opt.wasm"),
    idl: here("contracts", "session-registry", "client", "session_registry_client.idl"),
    init: "New",
    args: [],
    salt: "session-registry"
  });

  deployed.demoUsdc = uploadProgram({
    label: "demo-usdc-vft",
    wasm: here("contracts", "demo-usdc-vft", "target", "wasm32-gear", "debug", "demo_usdc_vft.opt.wasm"),
    idl: here("contracts", "demo-usdc-vft", "client", "demo_usdc_vft_client.idl"),
    init: "Create",
    args: [deployer.actorId],
    salt: "demo-usdc"
  });

  deployed.oracle = uploadProgram({
    label: "oracle-service",
    wasm: here("contracts", "oracle-service", "target", "wasm32-gear", "debug", "oracle_service.opt.wasm"),
    idl: here("contracts", "oracle-service", "client", "oracle_service_client.idl"),
    init: "Create",
    args: [deployer.actorId],
    salt: "oracle-service"
  });

  deployed.marginVault = uploadProgram({
    label: "margin-vault",
    wasm: here("contracts", "margin-vault", "target", "wasm32-gear", "debug", "margin_vault.opt.wasm"),
    idl: here("contracts", "margin-vault", "client", "margin_vault_client.idl"),
    init: "Create",
    args: [deployer.actorId, deployed.sessionRegistry.programId, deployed.demoUsdc.programId],
    salt: "margin-vault"
  });

  deployed.liquidityPool = uploadProgram({
    label: "liquidity-pool",
    wasm: here("contracts", "liquidity-pool", "target", "wasm32-gear", "debug", "liquidity_pool.opt.wasm"),
    idl: here("contracts", "liquidity-pool", "client", "liquidity_pool_client.idl"),
    init: "Create",
    args: [deployer.actorId, deployed.demoUsdc.programId, 50_000],
    salt: "liquidity-pool"
  });

  const risk = {
    initial_margin_bps: 1000,
    maintenance_margin_bps: 600,
    max_leverage: 50,
    funding_interval_blocks: 20,
    liquidation_delay_blocks: 5,
    max_funding_velocity_bps: 75
  };

  const markets = DEPLOY_ALL_MARKETS
    ? [
        ["btc", "Btc", "btc-market", "8000000000000"],
        ["eth", "Eth", "eth-market", "250000000000"],
        ["sol", "Sol", "sol-market", "10000000000"]
      ]
    : [["btc", "Btc", "btc-market", "8000000000000"]];

  for (const [key, asset, salt, initialPrice] of markets) {
    deployed[key] = uploadProgram({
      label: `${key}-market`,
      wasm: here("contracts", "perp-market", "target", "wasm32-gear", "debug", "perp_market.opt.wasm"),
      idl: here("contracts", "perp-market", "client", "perp_market_client.idl"),
      init: "Create",
      args: [
        {
          owner: deployer.actorId,
          asset,
          oracle_service: deployed.oracle.programId,
          margin_vault: deployed.marginVault.programId,
          liquidity_pool: deployed.liquidityPool.programId,
          session_registry: deployed.sessionRegistry.programId,
          risk
        },
        initialPrice,
        initialPrice
      ],
      salt
    });

    if (AUTHORIZE_MARKETS) {
      callFunction(
        deployed.marginVault.programId,
        here("contracts", "margin-vault", "client", "margin_vault_client.idl"),
        "Vault/AuthorizeMarket",
        [deployed[key].programId]
      );
      callFunction(
        deployed.liquidityPool.programId,
        here("contracts", "liquidity-pool", "client", "liquidity_pool_client.idl"),
        "Pool/AuthorizeMarket",
        [deployed[key].programId]
      );
    }
  }

  const envLines = [
    `VITE_NODE_ADDRESS=${WS}`,
    `VITE_VARA_RPC_URL=${WS}`,
    `VITE_DEMO_USDC_PROGRAM_ID=${deployed.demoUsdc.programId}`,
    `VITE_SESSION_REGISTRY_PROGRAM_ID=${deployed.sessionRegistry.programId}`,
    `VITE_MARGIN_VAULT_PROGRAM_ID=${deployed.marginVault.programId}`,
    `VITE_LIQUIDITY_POOL_PROGRAM_ID=${deployed.liquidityPool.programId}`,
    `VITE_ORACLE_SERVICE_PROGRAM_ID=${deployed.oracle.programId}`,
    `VITE_BTC_MARKET_PROGRAM_ID=${deployed.btc?.programId ?? ""}`,
    `VITE_ETH_MARKET_PROGRAM_ID=${deployed.eth?.programId ?? ""}`,
    `VITE_SOL_MARKET_PROGRAM_ID=${deployed.sol?.programId ?? ""}`
  ];

  const envPath = writeEnvFile(envLines);
  console.log(
    JSON.stringify(
      {
        ws: WS,
        account: VARA_ACCOUNT,
        deployer,
        authorizeMarkets: AUTHORIZE_MARKETS,
        deployAllMarkets: DEPLOY_ALL_MARKETS,
        outputEnvPath: envPath,
        deployed,
        envLines
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
