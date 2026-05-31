import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  stringToHex,
  webSocket
} from "@vara-eth/viem";
import { privateKeyToAccount } from "@vara-eth/viem/accounts";
import {
  CodeState,
  createVaraEthApi,
  getMirrorClient,
  ReplyCode,
  WsVaraEthProvider
} from "@vara-eth/api";
import { walletClientToSigner } from "@vara-eth/api/signer";
import { Sails } from "sails-js";
import { SailsIdlParser } from "sails-js-parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..", "..");

const ETH_RPC_URL = process.env.VARA_ETH_ETH_RPC_URL || "https://hoodi-reth-rpc.gear-tech.io";
const ETH_DEPLOY_RPC_URL =
  process.env.VARA_ETH_ETH_DEPLOY_RPC_URL || "wss://hoodi-reth-rpc.gear-tech.io/ws";
const VARA_RPC_URL = process.env.VARA_ETH_VARA_RPC_URL || "wss://vara-eth-validator-1.gear-tech.io";
const ROUTER_ADDRESS = process.env.VARA_ETH_ROUTER_ADDRESS || "0xE549b0AfEdA978271FF7E712232B9F7f39A0b060";
const CHAIN_ID = Number.parseInt(process.env.VARA_ETH_CHAIN_ID || "560048", 10);
const PRIVATE_KEY = process.env.VARA_ETH_DEPLOYER_PRIVATE_KEY?.trim() || "";
const DEPLOY_ALL_MARKETS = process.env.VARA_ETH_DEPLOY_ALL_MARKETS === "1";
const AUTHORIZE_MARKETS = process.env.VARA_ETH_AUTHORIZE_MARKETS !== "0";
const OUTPUT_ENV_PATH =
  process.env.VARA_ETH_OUTPUT_ENV_PATH || path.join("web", ".env.vara-eth.hoodi.local");
const EXECUTABLE_BALANCE_WVARA = process.env.VARA_ETH_EXECUTABLE_BALANCE_WVARA || "5";
const BUILD_PROFILE = process.env.VARA_ETH_BUILD_PROFILE || "release";
const VALIDATION_DEADLINE_MS = Number.parseInt(
  process.env.VARA_ETH_VALIDATION_DEADLINE_MS || "600000",
  10
);
const SALT_SUFFIX = process.env.VARA_ETH_SALT_SUFFIX?.trim() || "";
const ETHEXE_BIN =
  process.env.VARA_ETH_ETHEXE_BIN || "/private/tmp/ethexe-nightly-aarch64-apple-darwin/ethexe";

const CONTRACTS = {
  demoUsdc: {
    label: "demo-usdc-vft",
    wasm: ["contracts", "demo-usdc-vft", "target", "wasm32-gear", BUILD_PROFILE, "demo_usdc_vft.opt.wasm"],
    idl: ["contracts", "demo-usdc-vft", "client", "demo_usdc_vft_client.idl"],
    envCodeIdKey: "VARA_ETH_DEMO_USDC_CODE_ID"
  },
  marginVault: {
    label: "margin-vault",
    wasm: ["contracts", "margin-vault", "target", "wasm32-gear", BUILD_PROFILE, "margin_vault.opt.wasm"],
    idl: ["contracts", "margin-vault", "client", "margin_vault_client.idl"],
    envCodeIdKey: "VARA_ETH_MARGIN_VAULT_CODE_ID"
  },
  liquidityPool: {
    label: "liquidity-pool",
    wasm: ["contracts", "liquidity-pool", "target", "wasm32-gear", BUILD_PROFILE, "liquidity_pool.opt.wasm"],
    idl: ["contracts", "liquidity-pool", "client", "liquidity_pool_client.idl"],
    envCodeIdKey: "VARA_ETH_LIQUIDITY_POOL_CODE_ID"
  },
  perpMarket: {
    label: "perp-market",
    wasm: ["contracts", "perp-market", "target", "wasm32-gear", BUILD_PROFILE, "perp_market.opt.wasm"],
    idl: ["contracts", "perp-market", "client", "perp_market_client.idl"],
    envCodeIdKey: "VARA_ETH_PERP_MARKET_CODE_ID"
  }
};

const RISK = {
  initial_margin_bps: 1000,
  maintenance_margin_bps: 600,
  max_leverage: 50,
  funding_interval_blocks: 20,
  liquidation_delay_blocks: 5,
  max_funding_velocity_bps: 75
};

const MARKETS = DEPLOY_ALL_MARKETS
  ? [
      { key: "btc", asset: "Btc", label: "btc-market", initialPrice: "8000000000000" },
      { key: "eth", asset: "Eth", label: "eth-market", initialPrice: "250000000000" },
      { key: "sol", asset: "Sol", label: "sol-market", initialPrice: "10000000000" }
    ]
  : [{ key: "btc", asset: "Btc", label: "btc-market", initialPrice: "8000000000000" }];

function here(...parts) {
  return path.join(rootDir, ...parts);
}

function ensureFile(relativePathParts) {
  const filePath = here(...relativePathParts);
  if (existsSync(filePath)) {
    return filePath;
  }

  throw new Error(
    `missing required artifact: ${path.relative(rootDir, filePath)}\n` +
      "Build the Vara contracts first, for example:\n" +
      "  pnpm build:local-vara-contracts"
  );
}

function ensureEthexeBin() {
  if (existsSync(ETHEXE_BIN)) {
    return ETHEXE_BIN;
  }

  throw new Error(
    `missing ethexe binary: ${ETHEXE_BIN}\n` +
      "Download the nightly CLI or set VARA_ETH_ETHEXE_BIN to a working ethexe path."
  );
}

function createTransport(url) {
  if (url.startsWith("ws://") || url.startsWith("wss://")) {
    return webSocket(url);
  }
  return http(url);
}

function patchBlobFeeHistory(publicClient) {
  const originalGetFeeHistory = publicClient.getFeeHistory.bind(publicClient);
  const originalGetBlobBaseFee = publicClient.getBlobBaseFee?.bind(publicClient);

  if (!originalGetBlobBaseFee) {
    return;
  }

  publicClient.getFeeHistory = async (...args) => {
    const feeHistory = await originalGetFeeHistory(...args);
    if (Array.isArray(feeHistory.baseFeePerBlobGas) && feeHistory.baseFeePerBlobGas.length > 0) {
      return feeHistory;
    }

    const blobBaseFee = await originalGetBlobBaseFee();
    const blockCountArg = args[0]?.blockCount;
    const blockCount =
      typeof blockCountArg === "bigint"
        ? Number(blockCountArg)
        : typeof blockCountArg === "number"
          ? blockCountArg
          : 1;
    const count = Number.isFinite(blockCount) && blockCount > 0 ? blockCount + 1 : 2;

    return {
      ...feeHistory,
      baseFeePerBlobGas: Array.from({ length: count }, () => blobBaseFee)
    };
  };
}

function patchBlobEstimateGas(publicClient) {
  const originalEstimateGas = publicClient.estimateGas.bind(publicClient);

  publicClient.estimateGas = async (args) => {
    if (args?.type === "eip4844") {
      // Hoodi's gas estimator reverts while simulating blobhash access even though
      // the actual EIP-7594 transaction succeeds once submitted.
      return 1_000_000n;
    }

    return originalEstimateGas(args);
  };
}

function requirePrivateKey() {
  if (!PRIVATE_KEY) {
    throw new Error("set VARA_ETH_DEPLOYER_PRIVATE_KEY to the funded Hoodi deployer private key");
  }
}

function parseDecimalUnits(value, decimals) {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`invalid decimal value '${value}'`);
  }

  const [whole, fraction = ""] = normalized.split(".");
  const paddedFraction = `${fraction}${"0".repeat(decimals)}`.slice(0, decimals);
  return BigInt(`${whole}${paddedFraction}`);
}

function actorIdOf(address) {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

const ZERO_ACTOR_ID = `0x${"0".repeat(64)}`;

function saltFor(label) {
  return keccak256(stringToHex(SALT_SUFFIX ? `${label}-${SALT_SUFFIX}` : label));
}

function replyCodeReason(replyCodeHex) {
  const code = ReplyCode.fromBytes(replyCodeHex);
  return {
    code,
    reason: code.reason
  };
}

function assertReplySuccess(reply, label) {
  const { code, reason } = replyCodeReason(reply.replyCode);
  if (code.isError) {
    throw new Error(`${label} failed: ${reason}`);
  }
}

function assertReceiptSuccess(receipt, label) {
  if (receipt.status !== "success") {
    throw new Error(`${label} reverted: txHash=${receipt.transactionHash}`);
  }
}

async function createSailsProgram(idlPath) {
  const parser = await SailsIdlParser.new();
  return new Sails(parser).parseIdl(readFileSync(idlPath, "utf8"));
}

function formatCommand(bin, args) {
  return [bin, ...args].join(" ");
}

function runCommand(bin, args, label) {
  const result = spawnSync(bin, args, {
    cwd: rootDir,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  if (stdout.trim()) {
    console.log(stdout.trim());
  }
  if (stderr.trim()) {
    console.error(stderr.trim());
  }

  if (result.status !== 0) {
    const error = new Error(`${label} failed (${formatCommand(bin, args)})`);
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  }

  return `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`;
}

function lastMatch(output, pattern, label) {
  const matches = [...output.matchAll(pattern)];
  const last = matches.at(-1);
  const value = last ? last.slice(1).find(Boolean) : null;
  if (!value) {
    throw new Error(`could not parse ${label} from ethexe output`);
  }
  return value;
}

function createTempKeyStore(privateKey) {
  const ethexeBin = ensureEthexeBin();
  const keyStore = mkdtempSync(path.join(tmpdir(), "varix-ethexe-"));

  runCommand(
    ethexeBin,
    ["key", "-k", keyStore, "keyring", "init"],
    "initialize ethexe keyring"
  );
  runCommand(
    ethexeBin,
    [
      "key",
      "-k",
      keyStore,
      "keyring",
      "import",
      "--private-key",
      privateKey,
      "--name",
      "varix-deployer"
    ],
    "import deployer key into ethexe keyring"
  );

  return keyStore;
}

function ethexeBaseArgs(keyStore, sender) {
  return [
    "--cfg",
    "none",
    "tx",
    "--key-store",
    keyStore,
    "--ethereum-rpc",
    ETH_DEPLOY_RPC_URL,
    "--ethereum-router",
    ROUTER_ADDRESS,
    "--sender",
    sender
  ];
}

async function runQuery(api, source, destination, query, ...args) {
  const payload = query.encodePayload(...args);
  const reply = await api.call.program.calculateReplyForHandle(source, destination, payload);
  if (reply.code.isError) {
    throw new Error(`query ${destination} failed: ${reply.code.reason}`);
  }
  return query.decodeResult(reply.payload);
}

async function verifyInitialized(api, mirror, label) {
  const stateHash = await mirror.stateHash();
  const state = await api.query.program.readState(stateHash);
  if (!("Active" in state.program) || !state.program.Active.initialized) {
    throw new Error(`${label} is not initialized`);
  }

  return {
    stateHash,
    executableBalance: state.executableBalance.toString()
  };
}

async function waitForInitialized(api, mirror, label) {
  const deadlineAt = Date.now() + VALIDATION_DEADLINE_MS;

  while (Date.now() < deadlineAt) {
    const stateHash = await mirror.stateHash();
    const state = await api.query.program.readState(stateHash);
    if ("Active" in state.program && state.program.Active.initialized) {
      return;
    }
    await sleep(3_000);
  }

  throw new Error(`${label} did not reach initialized state before the deploy timeout elapsed`);
}

async function waitForExecutableBalance(api, mirror, label, minimumBalance) {
  const deadlineAt = Date.now() + VALIDATION_DEADLINE_MS;

  while (Date.now() < deadlineAt) {
    const stateHash = await mirror.stateHash();
    const state = await api.query.program.readState(stateHash);
    const executableBalance = BigInt(state.executableBalance.toString());

    if (executableBalance >= minimumBalance) {
      return {
        stateHash,
        executableBalance: executableBalance.toString()
      };
    }

    await sleep(3_000);
  }

  throw new Error(`${label} mirror never reached executable balance ${minimumBalance.toString()}`);
}

async function uploadCode({ api, label, envCodeIdKey, wasmPath, ethexeBin, keyStore, sender }) {
  const reusedCodeId = process.env[envCodeIdKey]?.trim();
  if (reusedCodeId) {
    const state = await api.eth.router.codeState(reusedCodeId);
    if (state !== CodeState.Validated) {
      throw new Error(`${label} code id ${reusedCodeId} is not validated on the target Router`);
    }
    console.log(`reusing ${label} code id ${reusedCodeId}`);
    return reusedCodeId;
  }

  console.log(`uploading ${label} code with nightly ethexe CLI`);
  let output;
  try {
    output = runCommand(
      ethexeBin,
      [...ethexeBaseArgs(keyStore, sender), "upload", "--watch", wasmPath],
      `upload ${label} code`
    );
  } catch (error) {
    const combined = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    if (combined.includes("CodeAlreadyOnValidationOrValidated")) {
      const codeId = lastMatch(combined, /code_id\s+(0x[a-fA-F0-9]+)/g, `${label} code id`);
      const state = await api.eth.router.codeState(codeId);
      if (state === CodeState.Validated) {
        console.log(`reusing already-validated ${label} code id ${codeId}`);
        return codeId;
      }
    }
    throw error;
  }
  const codeId = lastMatch(output, /Code id:[^\n]*(0x[a-fA-F0-9]+)/g, `${label} code id`);
  const state = await api.eth.router.codeState(codeId);
  if (state !== CodeState.Validated) {
    throw new Error(`${label} code ${codeId} did not finish in the validated state`);
  }
  console.log(`validated ${label}: ${codeId}`);
  return codeId;
}

async function createProgram({
  api,
  publicClient,
  signer,
  codeId,
  label,
  salt,
  executableBalance,
  ethexeBin,
  keyStore,
  sender
}) {
  console.log(`creating ${label} with nightly ethexe CLI`);
  const output = runCommand(
    ethexeBin,
    [
      ...ethexeBaseArgs(keyStore, sender),
      "create",
      codeId,
      "--salt",
      salt,
      "--value",
      executableBalance.toString(),
      "--json"
    ],
    `create ${label}`
  );
  const programId = lastMatch(
    output,
    /"actor_id":"(0x[a-fA-F0-9]+)"|Actor id:[^\n]*(0x[a-fA-F0-9]+)/g,
    `${label} program id`
  );
  const mirror = getMirrorClient({
    address: programId,
    publicClient,
    signer
  });
  console.log(`${label} mirror created: ${programId}`);
  await sleep(5_000);
  return { programId, mirror };
}

async function initProgram({ api, mirror, payload, label }) {
  console.log(`initializing ${label}`);
  const tx = await mirror.sendMessage(payload, 0n);
  const receipt = await tx.sendAndWaitForReceipt();
  assertReceiptSuccess(receipt, `${label} init tx`);
  await waitForInitialized(api, mirror, label);
  console.log(`initialized ${label}`);
}

async function sendProgramMessage({ mirror, payload, label }) {
  const tx = await mirror.sendMessage(payload, 0n);
  const receipt = await tx.sendAndWaitForReceipt();
  assertReceiptSuccess(receipt, `${label} tx`);
  await sleep(3_000);
}

function writeEnvFile(lines) {
  const absolutePath = here(OUTPUT_ENV_PATH);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${lines.join("\n")}\n`, "utf8");
  return absolutePath;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCodeValidated(api, codeId, label) {
  const deadlineAt = Date.now() + VALIDATION_DEADLINE_MS;
  let lastState = null;

  while (Date.now() < deadlineAt) {
    const state = await api.eth.router.codeState(codeId);

    if (state === CodeState.Validated) {
      return;
    }

    if (state === CodeState.Invalid) {
      throw new Error(`${label} code ${codeId} was marked invalid on the target Router`);
    }

    if (state !== lastState) {
      console.log(`waiting for ${label} code ${codeId} validation; state=${state}`);
      lastState = state;
    }

    await sleep(3_000);
  }

  throw new Error(`${label} code ${codeId} was not validated before the deploy timeout elapsed`);
}

async function main() {
  requirePrivateKey();
  const ethexeBin = ensureEthexeBin();

  const privateKey = PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
  const account = privateKeyToAccount(privateKey);
  const keyStore = createTempKeyStore(privateKey);
  const publicClient = createPublicClient({
    transport: createTransport(ETH_DEPLOY_RPC_URL)
  });
  patchBlobFeeHistory(publicClient);
  patchBlobEstimateGas(publicClient);
  const walletClient = createWalletClient({
    account,
    transport: createTransport(ETH_DEPLOY_RPC_URL)
  });
  const signer = walletClientToSigner(walletClient);
  const api = await createVaraEthApi(
    new WsVaraEthProvider(VARA_RPC_URL),
    publicClient,
    ROUTER_ADDRESS,
    signer
  );

  try {
    const nativeBalance = await publicClient.getBalance({ address: account.address });
    const wvaraBalance = await api.eth.wvara.balanceOf(account.address);
    const perProgramExecutableBalance = parseDecimalUnits(EXECUTABLE_BALANCE_WVARA, 12);

    console.log(
      `deployer=${account.address} chainId=${CHAIN_ID} buildProfile=${BUILD_PROFILE} nativeBalance=${nativeBalance.toString()} wVARA=${wvaraBalance.toString()}`
    );

    const [demoTokenSails, marginVaultSails, poolSails, marketSails] = await Promise.all([
      createSailsProgram(ensureFile(CONTRACTS.demoUsdc.idl)),
      createSailsProgram(ensureFile(CONTRACTS.marginVault.idl)),
      createSailsProgram(ensureFile(CONTRACTS.liquidityPool.idl)),
      createSailsProgram(ensureFile(CONTRACTS.perpMarket.idl))
    ]);

    const ownerActorId = actorIdOf(account.address);
    const deployed = {};
    const sender = account.address;

    const demoUsdcCode = await uploadCode({
      api,
      label: CONTRACTS.demoUsdc.label,
      envCodeIdKey: CONTRACTS.demoUsdc.envCodeIdKey,
      wasmPath: ensureFile(CONTRACTS.demoUsdc.wasm),
      ethexeBin,
      keyStore,
      sender
    });
    const demoUsdc = await createProgram({
      api,
      publicClient,
      signer,
      codeId: demoUsdcCode,
      label: CONTRACTS.demoUsdc.label,
      salt: saltFor(CONTRACTS.demoUsdc.label),
      executableBalance: perProgramExecutableBalance,
      ethexeBin,
      keyStore,
      sender
    });
    await initProgram({
      api,
      mirror: demoUsdc.mirror,
      payload: demoTokenSails.ctors.Create.encodePayload(ownerActorId),
      label: CONTRACTS.demoUsdc.label
    });
    const demoUsdcState = await verifyInitialized(api, demoUsdc.mirror, CONTRACTS.demoUsdc.label);
    deployed.demoUsdc = {
      codeId: demoUsdcCode,
      programId: demoUsdc.programId,
      ...demoUsdcState
    };

    const tokenActorId = actorIdOf(demoUsdc.programId);

    const marginVaultCode = await uploadCode({
      api,
      label: CONTRACTS.marginVault.label,
      envCodeIdKey: CONTRACTS.marginVault.envCodeIdKey,
      wasmPath: ensureFile(CONTRACTS.marginVault.wasm),
      ethexeBin,
      keyStore,
      sender
    });
    const marginVault = await createProgram({
      api,
      publicClient,
      signer,
      codeId: marginVaultCode,
      label: CONTRACTS.marginVault.label,
      salt: saltFor(CONTRACTS.marginVault.label),
      executableBalance: perProgramExecutableBalance,
      ethexeBin,
      keyStore,
      sender
    });
    await initProgram({
      api,
      mirror: marginVault.mirror,
      payload: marginVaultSails.ctors.Create.encodePayload(ownerActorId, ZERO_ACTOR_ID, tokenActorId),
      label: CONTRACTS.marginVault.label
    });
    const marginVaultState = await verifyInitialized(api, marginVault.mirror, CONTRACTS.marginVault.label);
    deployed.marginVault = {
      codeId: marginVaultCode,
      programId: marginVault.programId,
      ...marginVaultState
    };

    const liquidityPoolCode = await uploadCode({
      api,
      label: CONTRACTS.liquidityPool.label,
      envCodeIdKey: CONTRACTS.liquidityPool.envCodeIdKey,
      wasmPath: ensureFile(CONTRACTS.liquidityPool.wasm),
      ethexeBin,
      keyStore,
      sender
    });
    const liquidityPool = await createProgram({
      api,
      publicClient,
      signer,
      codeId: liquidityPoolCode,
      label: CONTRACTS.liquidityPool.label,
      salt: saltFor(CONTRACTS.liquidityPool.label),
      executableBalance: perProgramExecutableBalance,
      ethexeBin,
      keyStore,
      sender
    });
    await initProgram({
      api,
      mirror: liquidityPool.mirror,
      payload: poolSails.ctors.Create.encodePayload(ownerActorId, tokenActorId, 50_000),
      label: CONTRACTS.liquidityPool.label
    });
    const liquidityPoolState = await verifyInitialized(
      api,
      liquidityPool.mirror,
      CONTRACTS.liquidityPool.label
    );
    deployed.liquidityPool = {
      codeId: liquidityPoolCode,
      programId: liquidityPool.programId,
      ...liquidityPoolState
    };

    const marketCode = await uploadCode({
      api,
      label: CONTRACTS.perpMarket.label,
      envCodeIdKey: CONTRACTS.perpMarket.envCodeIdKey,
      wasmPath: ensureFile(CONTRACTS.perpMarket.wasm),
      ethexeBin,
      keyStore,
      sender
    });

    const vaultActorId = actorIdOf(marginVault.programId);
    const poolActorId = actorIdOf(liquidityPool.programId);
    const marketProgramIds = [];

    for (const marketDef of MARKETS) {
      const market = await createProgram({
        api,
        publicClient,
        signer,
        codeId: marketCode,
        label: marketDef.label,
        salt: saltFor(marketDef.label),
        executableBalance: perProgramExecutableBalance,
        ethexeBin,
        keyStore,
        sender
      });
      await initProgram({
        api,
        mirror: market.mirror,
        payload: marketSails.ctors.Create.encodePayload(
          {
            owner: ownerActorId,
            asset: marketDef.asset,
            oracle_service: ZERO_ACTOR_ID,
            margin_vault: vaultActorId,
            liquidity_pool: poolActorId,
            session_registry: ZERO_ACTOR_ID,
            risk: RISK
          },
          marketDef.initialPrice,
          marketDef.initialPrice
        ),
        label: marketDef.label
      });
      const marketState = await verifyInitialized(api, market.mirror, marketDef.label);
      deployed[marketDef.key] = {
        codeId: marketCode,
        programId: market.programId,
        ...marketState
      };
      marketProgramIds.push({
        ...marketDef,
        programId: market.programId,
        mirror: market.mirror
      });
    }

    if (AUTHORIZE_MARKETS) {
      const vaultAuthorize = marginVaultSails.services.Vault?.functions.AuthorizeMarket;
      const poolAuthorize = poolSails.services.Pool?.functions.AuthorizeMarket;
      if (!vaultAuthorize || !poolAuthorize) {
        throw new Error("authorize market functions are unavailable in the IDLs");
      }

      for (const market of marketProgramIds) {
        const marketActorId = actorIdOf(market.programId);
        await sendProgramMessage({
          mirror: marginVault.mirror,
          payload: vaultAuthorize.encodePayload(marketActorId),
          label: `authorize ${market.label} in margin-vault`
        });
        await sendProgramMessage({
          mirror: liquidityPool.mirror,
          payload: poolAuthorize.encodePayload(marketActorId),
          label: `authorize ${market.label} in liquidity-pool`
        });
      }
    }

    const marketStateQuery = marketSails.services.Market?.queries.MarketState;
    const vaultTotalsQuery = marginVaultSails.services.Vault?.queries.Totals;
    const poolStateQuery = poolSails.services.Pool?.queries.PoolState;
    if (!marketStateQuery || !vaultTotalsQuery || !poolStateQuery) {
      throw new Error("smoke queries are unavailable in one or more IDLs");
    }

    const smoke = {
      vaultTotals: await runQuery(api, account.address, marginVault.programId, vaultTotalsQuery),
      poolState: await runQuery(api, account.address, liquidityPool.programId, poolStateQuery),
      markets: {}
    };

    for (const market of marketProgramIds) {
      smoke.markets[market.key] = await runQuery(
        api,
        account.address,
        market.programId,
        marketStateQuery
      );
    }

    const envLines = [
      `VITE_VARA_ETH_ETH_RPC_URL=${ETH_RPC_URL}`,
      `VITE_VARA_ETH_VARA_RPC_URL=${VARA_RPC_URL}`,
      `VITE_VARA_ETH_ROUTER_ADDRESS=${ROUTER_ADDRESS}`,
      `VITE_VARA_ETH_CHAIN_ID=${CHAIN_ID}`,
      `VITE_VARA_ETH_DEMO_USDC_PROGRAM_ID=${deployed.demoUsdc.programId}`,
      `VITE_VARA_ETH_MARGIN_VAULT_PROGRAM_ID=${deployed.marginVault.programId}`,
      `VITE_VARA_ETH_LIQUIDITY_POOL_PROGRAM_ID=${deployed.liquidityPool.programId}`,
      `VITE_VARA_ETH_BTC_MARKET_PROGRAM_ID=${deployed.btc?.programId ?? ""}`,
      `VITE_VARA_ETH_ETH_MARKET_PROGRAM_ID=${deployed.eth?.programId ?? ""}`,
      `VITE_VARA_ETH_SOL_MARKET_PROGRAM_ID=${deployed.sol?.programId ?? ""}`
    ];

    const outputEnvPath = writeEnvFile(envLines);

    console.log(
      JSON.stringify(
        {
          chainId: CHAIN_ID,
          ethRpcUrl: ETH_RPC_URL,
          ethDeployRpcUrl: ETH_DEPLOY_RPC_URL,
          varaRpcUrl: VARA_RPC_URL,
          routerAddress: ROUTER_ADDRESS,
          deployer: account.address,
          authorizeMarkets: AUTHORIZE_MARKETS,
          deployAllMarkets: DEPLOY_ALL_MARKETS,
          executableBalancePerProgram: perProgramExecutableBalance.toString(),
          outputEnvPath,
          deployed,
          smoke,
          envLines
        },
        null,
        2
      )
    );
  } finally {
    await api.provider.disconnect();
  }
}

if (process.argv.includes("--help")) {
  console.log(`Deploy the minimal Varix Vara.eth stack to Ethereum Hoodi.

Required:
  VARA_ETH_DEPLOYER_PRIVATE_KEY   Funded Hoodi private key

Optional:
  VARA_ETH_ETH_RPC_URL            Default: ${ETH_RPC_URL}
  VARA_ETH_ETH_DEPLOY_RPC_URL     Default: ${ETH_DEPLOY_RPC_URL}
  VARA_ETH_VARA_RPC_URL           Default: ${VARA_RPC_URL}
  VARA_ETH_ROUTER_ADDRESS         Default: ${ROUTER_ADDRESS}
  VARA_ETH_CHAIN_ID               Default: ${CHAIN_ID}
  VARA_ETH_EXECUTABLE_BALANCE_WVARA
  VARA_ETH_BUILD_PROFILE         Default: ${BUILD_PROFILE}
  VARA_ETH_ETHEXE_BIN            Default: ${ETHEXE_BIN}
  VARA_ETH_DEPLOY_ALL_MARKETS=1
  VARA_ETH_AUTHORIZE_MARKETS=0
  VARA_ETH_OUTPUT_ENV_PATH
  VARA_ETH_SALT_SUFFIX
  VARA_ETH_DEMO_USDC_CODE_ID
  VARA_ETH_MARGIN_VAULT_CODE_ID
  VARA_ETH_LIQUIDITY_POOL_CODE_ID
  VARA_ETH_PERP_MARKET_CODE_ID

Run:
  pnpm build:local-vara-contracts
  pnpm deploy:hoodi-vara-eth
`);
} else if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
