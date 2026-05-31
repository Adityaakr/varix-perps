# Vara.eth Hoodi Deploy

This repo now has a minimal Hoodi deploy path for the Vara.eth trading stack:

- `demo-usdc-vft`
- `margin-vault`
- `liquidity-pool`
- `perp-market`

The deploy path intentionally skips `session-registry` and `oracle-service` for v1. The current contracts already tolerate:

- `session_registry = None`
- `oracle_service = None`

The frontend runtime already supports the injected Vara.eth flow end to end:

1. User signs with an EVM wallet.
2. The router returns a fast validator reply.
3. The UI surfaces that reply as an instant pre-confirmation.
4. The app keeps polling mirror state until the updated program state becomes visible.

The script lives at `web/scripts/deploy-vara-eth-hoodi.mjs`.

## What It Does

1. Uploads or reuses validated WASM code on the Hoodi Router.
2. Creates each program with initial executable WVARA balance.
3. Sends the constructor payload as the first init message.
4. Optionally authorizes each market in the vault and pool.
5. Smoke-reads vault, pool, and market state.
6. Writes the frontend env block to `web/.env.vara-eth.hoodi.local` by default.

## Prerequisites

1. Build the contracts:

```bash
pnpm build:local-vara-contracts
```

2. Fund the deployer on Hoodi with:

- Hoodi native gas
- `wVARA` for code validation fees and executable balances

3. Set a deployer private key:

```bash
export VARA_ETH_DEPLOYER_PRIVATE_KEY=0x...
export VARA_ETH_ETH_DEPLOY_RPC_URL=wss://hoodi-reth-rpc.gear-tech.io/ws
```

## Run

```bash
pnpm deploy:hoodi-vara-eth
```

## Useful Env

```bash
export VARA_ETH_EXECUTABLE_BALANCE_WVARA=5
export VARA_ETH_DEPLOY_ALL_MARKETS=1
export VARA_ETH_AUTHORIZE_MARKETS=1
export VARA_ETH_OUTPUT_ENV_PATH=web/.env.vara-eth.hoodi.local
export VARA_ETH_ETH_DEPLOY_RPC_URL=wss://hoodi-reth-rpc.gear-tech.io/ws
```

Optional code-id reuse:

```bash
export VARA_ETH_DEMO_USDC_CODE_ID=0x...
export VARA_ETH_MARGIN_VAULT_CODE_ID=0x...
export VARA_ETH_LIQUIDITY_POOL_CODE_ID=0x...
export VARA_ETH_PERP_MARKET_CODE_ID=0x...
```

## Output

The script prints a JSON summary and writes:

- `VITE_VARA_ETH_ETH_RPC_URL`
- `VITE_VARA_ETH_VARA_RPC_URL`
- `VITE_VARA_ETH_ROUTER_ADDRESS`
- `VITE_VARA_ETH_CHAIN_ID`
- `VITE_VARA_ETH_DEMO_USDC_PROGRAM_ID`
- `VITE_VARA_ETH_MARGIN_VAULT_PROGRAM_ID`
- `VITE_VARA_ETH_LIQUIDITY_POOL_PROGRAM_ID`
- `VITE_VARA_ETH_BTC_MARKET_PROGRAM_ID`
- `VITE_VARA_ETH_ETH_MARKET_PROGRAM_ID`
- `VITE_VARA_ETH_SOL_MARKET_PROGRAM_ID`
