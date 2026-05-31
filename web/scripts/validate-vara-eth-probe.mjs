import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, webSocket } from "@vara-eth/viem";
import { privateKeyToAccount } from "@vara-eth/viem/accounts";
import { CodeState, createVaraEthApi, WsVaraEthProvider } from "@vara-eth/api";
import { walletClientToSigner } from "@vara-eth/api/signer";
import { initKzgLoading } from "@vara-eth/api/util";

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
const VALIDATION_DEADLINE_MS = Number.parseInt(
  process.env.VARA_ETH_VALIDATION_DEADLINE_MS || "600000",
  10
);

function requirePrivateKey() {
  if (!PRIVATE_KEY) {
    throw new Error("set VARA_ETH_DEPLOYER_PRIVATE_KEY");
  }
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
  if (!originalGetBlobBaseFee) return;

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
      return 1_000_000n;
    }
    return originalEstimateGas(args);
  };
}

async function waitForCodeValidated(api, codeId) {
  const deadlineAt = Date.now() + VALIDATION_DEADLINE_MS;
  while (Date.now() < deadlineAt) {
    const state = await api.eth.router.codeState(codeId);
    if (state === CodeState.Validated) return;
    if (state === CodeState.Invalid) {
      throw new Error(`probe code became invalid: ${codeId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`probe validation timed out: ${codeId}`);
}

async function main() {
  requirePrivateKey();
  await initKzgLoading();

  const account = privateKeyToAccount(PRIVATE_KEY);
  const publicClient = createPublicClient({
    chain: { id: CHAIN_ID, name: "Hoodi", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [ETH_RPC_URL], webSocket: [ETH_DEPLOY_RPC_URL] } } },
    transport: createTransport(ETH_DEPLOY_RPC_URL)
  });
  patchBlobFeeHistory(publicClient);
  patchBlobEstimateGas(publicClient);

  const walletClient = createWalletClient({
    account,
    chain: { id: CHAIN_ID, name: "Hoodi", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [ETH_RPC_URL], webSocket: [ETH_DEPLOY_RPC_URL] } } },
    transport: createTransport(ETH_DEPLOY_RPC_URL)
  });
  const signer = walletClientToSigner(walletClient);
  const api = await createVaraEthApi(
    new WsVaraEthProvider(VARA_RPC_URL),
    publicClient,
    ROUTER_ADDRESS,
    signer
  );

  const code = readFileSync(
    path.join(rootDir, "contracts", "vara-eth-probe", "target", "wasm32-gear", "release", "vara_eth_probe.opt.wasm")
  );
  const router = api.eth.router;
  const wvara = api.eth.wvara;
  const deadline = BigInt(Date.now() + VALIDATION_DEADLINE_MS);
  const fee =
    (await router.requestCodeValidationBaseFee()) +
    (await router.requestCodeValidationExtraFee());
  const { signature } = await wvara.prepareAndSignPermitData(router.address, fee, deadline);

  console.log(`probe deployer=${account.address} chainId=${CHAIN_ID} fee=${fee.toString()}`);
  const tx = await router.requestCodeValidation(code, deadline, signature);
  console.log(`probe codeId=${tx.codeId}`);
  const receipt = await tx.sendAndWaitForReceipt();
  console.log(`probe receipt status=${receipt.status} txHash=${receipt.transactionHash}`);
  if (receipt.status !== "success") {
    throw new Error(`probe validation reverted: ${receipt.transactionHash}`);
  }
  await waitForCodeValidated(api, tx.codeId);
  console.log(`probe validated=${tx.codeId}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
