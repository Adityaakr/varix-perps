const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const rootDir = process.cwd();

const WS = process.env.VARA_LOCAL_WS || "ws://127.0.0.1:9944";
const MAX_GAS_LIMIT = "750000000000";
const VARA_WALLET_BIN = process.env.VARA_WALLET_BIN || "vara-wallet";
const LOCAL_SEED = process.env.VARA_LOCAL_SEED || "//Alice";
const ACCOUNT_HEX = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";
const DEPLOY_ALL_MARKETS = process.env.VARA_LOCAL_ALL_MARKETS === "1";
const AUTHORIZE_MARKETS = process.env.VARA_LOCAL_AUTHORIZE_MARKETS !== "0";

function here(...parts) {
  return path.join(rootDir, ...parts);
}

function saltHex(label) {
  return `0x${Buffer.from(label, "utf8").toString("hex")}`;
}

function ensureFile(filePath) {
  if (fs.existsSync(filePath)) {
    return filePath;
  }

  throw new Error(
    `missing required artifact: ${path.relative(rootDir, filePath)}\n` +
      "Build the local Vara contracts first, for example:\n" +
      "  cargo build --manifest-path contracts/session-registry/Cargo.toml\n" +
      "  cargo build --manifest-path contracts/demo-usdc-vft/Cargo.toml\n" +
      "  cargo build --manifest-path contracts/oracle-service/Cargo.toml\n" +
      "  cargo build --manifest-path contracts/margin-vault/Cargo.toml\n" +
      "  cargo build --manifest-path contracts/liquidity-pool/Cargo.toml\n" +
      "  cargo build --manifest-path contracts/perp-market/Cargo.toml"
  );
}

function runWallet(args) {
  const walletIsJsEntrypoint = VARA_WALLET_BIN.endsWith(".js");
  const command = walletIsJsEntrypoint ? "node" : VARA_WALLET_BIN;
  const commandArgs = walletIsJsEntrypoint
    ? [VARA_WALLET_BIN, "--ws", WS, "--seed", LOCAL_SEED, "--json", ...args]
    : ["--ws", WS, "--seed", LOCAL_SEED, "--json", ...args];

  try {
    const output = execFileSync(command, commandArgs, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    return JSON.parse(output);
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
    saltHex(salt),
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

async function main() {
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
    args: [ACCOUNT_HEX, "Demo USD Coin", "dUSDC", 6],
    salt: "demo-usdc"
  });

  deployed.oracle = uploadProgram({
    label: "oracle-service",
    wasm: here("contracts", "oracle-service", "target", "wasm32-gear", "debug", "oracle_service.opt.wasm"),
    idl: here("contracts", "oracle-service", "client", "oracle_service_client.idl"),
    init: "Create",
    args: [ACCOUNT_HEX],
    salt: "oracle-service"
  });

  deployed.marginVault = uploadProgram({
    label: "margin-vault",
    wasm: here("contracts", "margin-vault", "target", "wasm32-gear", "debug", "margin_vault.opt.wasm"),
    idl: here("contracts", "margin-vault", "client", "margin_vault_client.idl"),
    init: "Create",
    args: [ACCOUNT_HEX, deployed.sessionRegistry.programId, deployed.demoUsdc.programId],
    salt: "margin-vault"
  });

  deployed.liquidityPool = uploadProgram({
    label: "liquidity-pool",
    wasm: here("contracts", "liquidity-pool", "target", "wasm32-gear", "debug", "liquidity_pool.opt.wasm"),
    idl: here("contracts", "liquidity-pool", "client", "liquidity_pool_client.idl"),
    init: "Create",
    args: [ACCOUNT_HEX, deployed.demoUsdc.programId, 50_000],
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
          owner: ACCOUNT_HEX,
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
    `VITE_DEMO_USDC_PROGRAM_ID=${deployed.demoUsdc.programId}`,
    `VITE_SESSION_REGISTRY_PROGRAM_ID=${deployed.sessionRegistry.programId}`,
    `VITE_MARGIN_VAULT_PROGRAM_ID=${deployed.marginVault.programId}`,
    `VITE_LIQUIDITY_POOL_PROGRAM_ID=${deployed.liquidityPool.programId}`,
    `VITE_ORACLE_SERVICE_PROGRAM_ID=${deployed.oracle.programId}`,
    `VITE_BTC_MARKET_PROGRAM_ID=${deployed.btc?.programId ?? ""}`,
    `VITE_ETH_MARKET_PROGRAM_ID=${deployed.eth?.programId ?? ""}`,
    `VITE_SOL_MARKET_PROGRAM_ID=${deployed.sol?.programId ?? ""}`
  ];

  fs.writeFileSync(here("web", ".env.local"), `${envLines.join("\n")}\n`, "utf8");
  console.log(JSON.stringify({ ws: WS, authorizeMarkets: AUTHORIZE_MARKETS, deployed, envLines }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
