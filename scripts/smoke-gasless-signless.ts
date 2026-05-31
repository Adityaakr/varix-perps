import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { GearApi } from "../web/node_modules/@gear-js/api";
import { Keyring } from "../web/node_modules/@polkadot/keyring";
import { u8aToHex } from "../web/node_modules/@polkadot/util";
import { cryptoWaitReady, mnemonicGenerate } from "../web/node_modules/@polkadot/util-crypto";
import { Sails } from "../web/node_modules/sails-js";
import { SailsIdlParser } from "../web/node_modules/sails-js-parser";

const PRICE_SCALE = 100_000_000n;
const PRICE_TO_COLLATERAL_SCALE = 100n;
const SIZE_FROM_NOTIONAL_SCALE = PRICE_SCALE * PRICE_TO_COLLATERAL_SCALE;
const MAX_U128 = (1n << 128n) - 1n;
const TRADE_GAS_LIMIT = 750_000_000_000n;

type EnvMap = Record<string, string>;

type SponsoredVoucher = {
  voucherId: string;
};

type SponsoredVoucherBundle = {
  owner: SponsoredVoucher | null;
  session: SponsoredVoucher | null;
};

function readEnvFile(filePath: string) {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .reduce<EnvMap>((acc, line) => {
      const separator = line.indexOf("=");
      if (separator === -1) {
        return acc;
      }
      const key = line.slice(0, separator);
      const value = line.slice(separator + 1);
      acc[key] = value;
      return acc;
    }, {});
}

async function main() {
  const env = readEnvFile(join(process.cwd(), "web", ".env.testnet.local"));
  const sponsorAccount = process.env.VARA_VOUCHER_SPONSOR_ACCOUNT ?? "agent100";
  const sponsorWalletBin = process.env.VARA_WALLET_BIN ?? "vara-wallet";
  const ws = env.VITE_NODE_ADDRESS || env.VITE_VARA_RPC_URL;
  const sessionRegistryId = env.VITE_SESSION_REGISTRY_PROGRAM_ID;
  const tokenId = env.VITE_DEMO_USDC_PROGRAM_ID;
  const vaultId = env.VITE_MARGIN_VAULT_PROGRAM_ID;
  const poolId = env.VITE_LIQUIDITY_POOL_PROGRAM_ID;
  const marketId = env.VITE_BTC_MARKET_PROGRAM_ID;
  if (!ws || !sessionRegistryId || !tokenId || !vaultId || !poolId || !marketId) {
    throw new Error("missing required testnet env config");
  }

  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519" });
  const owner = keyring.addFromUri(mnemonicGenerate());
  const session = keyring.addFromUri(mnemonicGenerate());
  const ownerActorId = u8aToHex(owner.addressRaw);
  const sessionActorId = u8aToHex(session.addressRaw);

  const issueVoucher = (spender: string, programs: string[]) => {
    const result = execFileSync(
      sponsorWalletBin,
      [
        "--network",
        "testnet",
        "--account",
        sponsorAccount,
        "--json",
        "voucher",
        "issue",
        spender,
        "50",
        "--duration",
        "14400",
        "--programs",
        programs.join(",")
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }
    ).trim();
    return JSON.parse(result) as SponsoredVoucher;
  };

  const ensureNativeBalance = async (address: string) => {
    const readBalance = () => JSON.parse(
      execFileSync(
        sponsorWalletBin,
        ["--network", "testnet", "--account", sponsorAccount, "--json", "balance", address],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"]
        }
      ).trim()
    ) as { balanceRaw?: string };
    const balance = readBalance();
    if (BigInt(balance.balanceRaw ?? "0") > 0n) {
      return;
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        execFileSync(
          sponsorWalletBin,
          ["--network", "testnet", "--account", sponsorAccount, "--json", "transfer", address, "10"],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"]
          }
        );
      } catch {
        const refreshed = readBalance();
        if (BigInt(refreshed.balanceRaw ?? "0") > 0n) {
          return;
        }
        await sleep(2_000);
      }
    }

    throw new Error(`failed to sponsor native balance for ${address}`);
  };

  await ensureNativeBalance(owner.address);
  await ensureNativeBalance(session.address);
  console.log("owner ss58", owner.address);
  console.log("session ss58", session.address);

  const vouchers: SponsoredVoucherBundle = {
    owner: issueVoucher(owner.address, [sessionRegistryId, tokenId, vaultId, poolId, marketId]),
    session: issueVoucher(session.address, [vaultId, marketId])
  };
  assert.ok(vouchers.owner?.voucherId, "missing owner voucher");
  assert.ok(vouchers.session?.voucherId, "missing session voucher");

  const api = await GearApi.create({ providerAddress: ws });
  const parser = await SailsIdlParser.new();
  const ownerNativeBefore = await api.query.system.account(owner.address);
  const sessionNativeBefore = await api.query.system.account(session.address);
  console.log("owner native before", ownerNativeBefore.data.free.toString());
  console.log("session native before", sessionNativeBefore.data.free.toString());

  const sessionRegistryIdl = readFileSync(join(process.cwd(), "web", "src", "idl", "session-registry.idl"), "utf8");
  const tokenIdl = readFileSync(join(process.cwd(), "web", "src", "idl", "demo-usdc-vft.idl"), "utf8");
  const vaultIdl = readFileSync(join(process.cwd(), "web", "src", "idl", "margin-vault.idl"), "utf8");
  const poolIdl = readFileSync(join(process.cwd(), "web", "src", "idl", "liquidity-pool.idl"), "utf8");
  const marketIdl = readFileSync(join(process.cwd(), "web", "src", "idl", "perp-market.idl"), "utf8");

  const sessionProgram = new Sails(parser).setApi(api).setProgramId(sessionRegistryId).parseIdl(sessionRegistryIdl);
  const tokenProgram = new Sails(parser).setApi(api).setProgramId(tokenId).parseIdl(tokenIdl);
  const vaultProgram = new Sails(parser).setApi(api).setProgramId(vaultId).parseIdl(vaultIdl);
  const poolProgram = new Sails(parser).setApi(api).setProgramId(poolId).parseIdl(poolIdl);
  const marketProgram = new Sails(parser).setApi(api).setProgramId(marketId).parseIdl(marketIdl);

  const registerSession = sessionProgram.services.SessionRegistry.functions.RegisterSession;
  const activeSession = sessionProgram.services.SessionRegistry.queries.ActiveSession;
  const approve = tokenProgram.services.Token.functions.Approve;
  const mint = tokenProgram.services.Token.functions.Mint;
  const allowance = tokenProgram.services.Token.queries.Allowance;
  const balanceOf = tokenProgram.services.Token.queries.BalanceOf;
  const deposit = vaultProgram.services.Vault.functions.Deposit;
  const withdraw = vaultProgram.services.Vault.functions.Withdraw;
  const vaultAccount = vaultProgram.services.Vault.queries.Account;
  const depositLiquidity = poolProgram.services.Pool.functions.DepositLiquidity;
  const marketState = marketProgram.services.Market.queries.MarketState;
  const positions = marketProgram.services.Market.queries.Positions;
  const openPosition = marketProgram.services.Market.functions.OpenPosition;
  const closePosition = marketProgram.services.Market.functions.ClosePosition;

  if (!registerSession || !activeSession || !approve || !mint || !allowance || !balanceOf || !deposit || !withdraw || !vaultAccount || !depositLiquidity || !marketState || !positions || !openPosition || !closePosition) {
    throw new Error("required program surface is unavailable");
  }

  const blockNumber = Number((await api.query.system.number()).toString());
  const expiresAt = blockNumber + 1_800;

  const registerTx = registerSession(sessionActorId, expiresAt, {
    trade: true,
    add_margin: true,
    withdraw: true
  });
  console.log("step: register session");
  registerTx.withAccount(owner).withVoucher(vouchers.owner.voucherId);
  await registerTx.calculateGas();
  await (await registerTx.signAndSend()).response();

  const approveVaultTx = approve(vaultId, MAX_U128);
  console.log("step: approve vault");
  approveVaultTx.withAccount(owner).withVoucher(vouchers.owner.voucherId);
  await approveVaultTx.calculateGas();
  await (await approveVaultTx.signAndSend()).response();

  const approvePoolTx = approve(poolId, MAX_U128);
  console.log("step: approve pool");
  approvePoolTx.withAccount(owner).withVoucher(vouchers.owner.voucherId);
  await approvePoolTx.calculateGas();
  await (await approvePoolTx.signAndSend()).response();

  const mintTx = mint(120_000_000_000n);
  console.log("step: mint demo collateral");
  mintTx.withAccount(owner).withVoucher(vouchers.owner.voucherId);
  await mintTx.calculateGas();
  await (await mintTx.signAndSend()).response();
  console.log("wallet balance after mint", await balanceOf(owner.address, 0n, undefined, ownerActorId));

  const lpTx = depositLiquidity(60_000_000_000n);
  console.log("step: fund lp");
  lpTx.withAccount(owner).withVoucher(vouchers.owner.voucherId);
  await lpTx.calculateGas();
  await (await lpTx.signAndSend()).response();
  console.log("wallet balance after lp", await balanceOf(owner.address, 0n, undefined, ownerActorId));

  const depositTx = deposit(20_000_000_000n);
  console.log("step: deposit from session");
  depositTx.withAccount(session).withVoucher(vouchers.session.voucherId);
  await depositTx.calculateGas();
  await (await depositTx.signAndSend()).response();

  const sessionRecord = await activeSession(owner.address, 0n, undefined, ownerActorId);
  assert.ok(sessionRecord, "session was not registered");

  const vaultSnapshotAfterDeposit = await vaultAccount(owner.address, 0n, undefined, ownerActorId);
  assert.equal(BigInt(vaultSnapshotAfterDeposit.free), 20_000_000_000n, "deposit did not reach vault");

  const currentAllowance = await allowance(owner.address, 0n, undefined, ownerActorId, vaultId);
  assert.ok(BigInt(currentAllowance) > 1_000_000_000n, "vault allowance not configured");

  const marketSnapshot = await marketState(owner.address, 0n, undefined);
  const markPrice = BigInt(marketSnapshot.mark_price);
  const notional = 10_000_000_000n;
  const size = (notional * SIZE_FROM_NOTIONAL_SCALE) / markPrice;
  const actualNotional = (size * markPrice) / PRICE_SCALE / PRICE_TO_COLLATERAL_SCALE;
  const margin = (actualNotional / 5n) + 1n;

  const openTx = openPosition("Long", size, 5, margin, 50);
  console.log("step: open position");
  openTx.withAccount(session).withVoucher(vouchers.session.voucherId).withGas(TRADE_GAS_LIMIT);
  const opened = await (await openTx.signAndSend()).response();

  const openPositions = await positions(owner.address, 0n, undefined, ownerActorId);
  assert.equal(openPositions.length, 1, "expected one open position");

  const closeTx = closePosition(opened.id, size);
  console.log("step: close position");
  closeTx.withAccount(session).withVoucher(vouchers.session.voucherId).withGas(TRADE_GAS_LIMIT);
  await (await closeTx.signAndSend()).response();

  const positionsAfterClose = await positions(owner.address, 0n, undefined, ownerActorId);
  assert.equal(positionsAfterClose.length, 0, "expected all positions to be closed");

  const withdrawTx = withdraw(5_000_000_000n);
  console.log("step: withdraw from session");
  withdrawTx.withAccount(session).withVoucher(vouchers.session.voucherId);
  await withdrawTx.calculateGas();
  await (await withdrawTx.signAndSend()).response();

  const vaultSnapshotAfterWithdraw = await vaultAccount(owner.address, 0n, undefined, ownerActorId);
  assert.equal(BigInt(vaultSnapshotAfterWithdraw.free), 15_000_000_000n, "withdraw did not reduce vault balance correctly");

  const walletBalance = await balanceOf(owner.address, 0n, undefined, ownerActorId);
  assert.ok(BigInt(walletBalance) >= 65_000_000_000n, "wallet balance did not receive withdrawn collateral");

  const ownerNativeBalance = await api.query.system.account(owner.address);
  const sessionNativeBalance = await api.query.system.account(session.address);

  console.log(JSON.stringify({
    owner: {
      ss58: owner.address,
      actorId: ownerActorId,
      nativeBalance: ownerNativeBalance.data.free.toString()
    },
    session: {
      ss58: session.address,
      actorId: sessionActorId,
      nativeBalance: sessionNativeBalance.data.free.toString()
    },
    vouchers,
    openedPositionId: opened.id,
    freeCollateralAfterWithdraw: vaultSnapshotAfterWithdraw.free,
    walletBalance
  }, null, 2));

  await api.disconnect();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
