use demo_usdc_vft_client::{token::Token, DemoUsdcVftClient, DemoUsdcVftClientCtors, DemoUsdcVftClientProgram};
use liquidity_pool_client::{pool::Pool, LiquidityPoolClient, LiquidityPoolClientCtors, LiquidityPoolClientProgram};
use margin_vault_client::{vault::Vault, MarginVaultClient, MarginVaultClientCtors, MarginVaultClientProgram};
use perp_market_client::{
    market::Market, Asset, MarketConfig, MarketRiskConfig, PerpMarketClient, PerpMarketClientCtors,
    PerpMarketClientProgram, Side,
};
use sails_rs::{
    client::{Actor, GclientEnv, GearEnv as _},
    gclient::GearApi,
    ActorId,
};
use session_registry_client::{SessionRegistryClientCtors, SessionRegistryClientProgram};
use std::time::Duration;

fn risk_config() -> MarketRiskConfig {
    MarketRiskConfig {
        initial_margin_bps: 2_000,
        maintenance_margin_bps: 1_000,
        max_leverage: 10,
        funding_interval_blocks: 20,
        liquidation_delay_blocks: 5,
        max_funding_velocity_bps: 75,
    }
}

#[tokio::test]
#[ignore = "requires a running local gear node on ws://127.0.0.1:9944"]
async fn local_node_btc_flow_works_end_to_end() {
    println!("connect apis");
    let owner_api = GearApi::builder()
        .uri("ws://127.0.0.1:9944")
        .timeout(Duration::from_secs(600))
        .build()
        .await
        .unwrap();
    let trader_api = owner_api.clone().with("//Bob").unwrap();
    let lp_api = owner_api.clone().with("//Charlie").unwrap();

    let owner = ActorId::from(<[u8; 32]>::from(owner_api.account_id().clone()));
    let trader = ActorId::from(<[u8; 32]>::from(trader_api.account_id().clone()));

    let owner_env = GclientEnv::new(owner_api.clone());
    let trader_env = GclientEnv::new(trader_api);
    let lp_env = GclientEnv::new(lp_api);

    println!("upload code");
    let token_code_id = owner_api.upload_code(demo_usdc_vft::WASM_BINARY).await.unwrap().0;
    let session_registry_code_id = owner_api.upload_code(session_registry::WASM_BINARY).await.unwrap().0;
    let vault_code_id = owner_api.upload_code(margin_vault::WASM_BINARY).await.unwrap().0;
    let pool_code_id = owner_api.upload_code(liquidity_pool::WASM_BINARY).await.unwrap().0;
    let market_code_id = owner_api.upload_code(perp_market::WASM_BINARY).await.unwrap().0;

    println!("deploy token");
    let token = owner_env
        .deploy::<DemoUsdcVftClientProgram>(token_code_id, b"token-live".to_vec())
        .create(owner, "Demo USDC".into(), "dUSDC".into(), 6)
        .await
        .unwrap();
    println!("deploy session registry");
    let session_registry = owner_env
        .deploy::<SessionRegistryClientProgram>(session_registry_code_id, b"sessions-live".to_vec())
        .new()
        .await
        .unwrap();
    println!("deploy vault");
    let vault = owner_env
        .deploy::<MarginVaultClientProgram>(vault_code_id, b"vault-live".to_vec())
        .create(owner, Some(session_registry.id()), Some(token.id()))
        .await
        .unwrap();
    println!("deploy pool");
    let pool = owner_env
        .deploy::<LiquidityPoolClientProgram>(pool_code_id, b"pool-live".to_vec())
        .create(owner, token.id(), 50_000)
        .await
        .unwrap();
    println!("deploy market");
    let market = owner_env
        .deploy::<PerpMarketClientProgram>(market_code_id, b"btc-live".to_vec())
        .create(
            MarketConfig {
                owner,
                asset: Asset::Btc,
                oracle_service: None,
                margin_vault: Some(vault.id()),
                liquidity_pool: Some(pool.id()),
                session_registry: Some(session_registry.id()),
                risk: risk_config(),
            },
            8_000_000_000_000,
            8_000_000_000_000,
        )
        .await
        .unwrap();

    println!("authorize market");
    vault.vault().authorize_market(market.id()).await.unwrap();
    pool.pool().authorize_market(market.id()).await.unwrap();

    println!("mint trader token");
    let trader_token = Actor::<DemoUsdcVftClientProgram, _>::new(trader_env.clone(), token.id());
    let mut trader_token_service = trader_token.token();
    trader_token_service.mint(20_000_000_000).await.unwrap();
    println!("approve trader vault");
    trader_token_service.approve(vault.id(), 20_000_000_000).await.unwrap();

    println!("deposit trader collateral");
    let trader_vault = Actor::<MarginVaultClientProgram, _>::new(trader_env.clone(), vault.id());
    let deposited = trader_vault.vault().deposit(12_000_000_000).await.unwrap();
    assert_eq!(deposited.free, 12_000_000_000);
    assert_eq!(deposited.locked, 0);

    println!("mint lp token");
    let lp_token = Actor::<DemoUsdcVftClientProgram, _>::new(lp_env.clone(), token.id());
    let mut lp_token_service = lp_token.token();
    lp_token_service.mint(50_000_000_000).await.unwrap();
    println!("approve lp pool");
    lp_token_service.approve(pool.id(), 50_000_000_000).await.unwrap();

    println!("deposit lp liquidity");
    let lp_pool = Actor::<LiquidityPoolClientProgram, _>::new(lp_env.clone(), pool.id());
    let lp_account = lp_pool.pool().deposit_liquidity(50_000_000_000).await.unwrap();
    assert_eq!(lp_account.deposited, 50_000_000_000);

    println!("open position");
    let trader_market = Actor::<PerpMarketClientProgram, _>::new(trader_env.clone(), market.id());
    let opened = trader_market
        .market()
        .open_position(Side::Long, 100_000_000, 5, 12_000_000_000, 50)
        .await
        .unwrap();
    assert!(opened.size > 0);
    assert_eq!(opened.margin, 12_000_000_000);

    println!("query post-open pool");
    let pool_state_after_open = pool.pool().pool_state().query().await.unwrap();
    assert_eq!(pool_state_after_open.reserved_notional, 100_000_000);

    println!("query post-open vault");
    let trader_account_after_open = vault.vault().account(trader).query().await.unwrap();
    assert_eq!(trader_account_after_open.free, 0);
    assert_eq!(trader_account_after_open.locked, 12_000_000_000);

    println!("close position");
    let closed = trader_market.market().close_position(100_000_000).await.unwrap();
    assert_eq!(closed.remaining_margin, 0);

    println!("query post-close vault");
    let trader_account_after_close = vault.vault().account(trader).query().await.unwrap();
    assert_eq!(trader_account_after_close.locked, 0);
    assert!(trader_account_after_close.free > 0);

    println!("query post-close pool");
    let pool_state_after_close = pool.pool().pool_state().query().await.unwrap();
    assert_eq!(pool_state_after_close.reserved_notional, 0);

    println!("query position after close");
    let position_after_close = market.market().position(trader).query().await.unwrap();
    assert!(position_after_close.is_none());
    println!("done");
}
