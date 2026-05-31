use demo_usdc_vft_client::{
    DemoUsdcVftClient, DemoUsdcVftClientCtors, DemoUsdcVftClientProgram, token::Token,
};
use liquidity_pool_client::{
    LiquidityPoolClient, LiquidityPoolClientCtors, LiquidityPoolClientProgram, pool::*,
};
use margin_vault_client::{
    MarginVaultClient, MarginVaultClientCtors, MarginVaultClientProgram, vault::*,
};
use perp_market_client::{
    Asset, MarketConfig, MarketRiskConfig, PerpMarketClient, PerpMarketClientCtors,
    PerpMarketClientProgram, Side, market::*,
};
use sails_rs::{client::*, gtest::*};
use session_registry_client::{
    SessionPermissions, SessionRegistryClient, SessionRegistryClientCtors,
    SessionRegistryClientProgram, session_registry::SessionRegistry,
};

const OWNER: u64 = 1;
const TRADER: u64 = 42;
const SESSION: u64 = 99;
const LP: u64 = 77;

fn zero_actor_id() -> sails_rs::ActorId {
    sails_rs::ActorId::from([0u8; 32])
}

fn risk_config() -> MarketRiskConfig {
    MarketRiskConfig {
        initial_margin_bps: 2_000,
        maintenance_margin_bps: 1_000,
        max_leverage: 10,
        funding_interval_blocks: 2,
        liquidation_delay_blocks: 2,
        max_funding_velocity_bps: 75,
    }
}

#[tokio::test]
async fn market_opens_settles_funding_and_liquidates() {
    let system = System::new();
    system.init_logger_with_default_filter("gwasm=debug,gtest=info,sails_rs=debug");
    system.mint_to(OWNER, 1_000_000_000_000_000);
    system.mint_to(TRADER, 1_000_000_000_000_000);
    system.mint_to(SESSION, 1_000_000_000_000_000);
    system.mint_to(LP, 1_000_000_000_000_000);
    let token_code_id = system.submit_code(demo_usdc_vft::WASM_BINARY);
    let vault_code_id = system.submit_code(margin_vault::WASM_BINARY);
    let pool_code_id = system.submit_code(liquidity_pool::WASM_BINARY);
    let code_id = system.submit_code(perp_market::WASM_BINARY);
    let session_registry_code_id = system.submit_code(session_registry::WASM_BINARY);

    let owner_env = GtestEnv::new(system, OWNER.into());
    let token = owner_env
        .deploy::<DemoUsdcVftClientProgram>(token_code_id, b"token".to_vec())
        .create(OWNER.into())
        .await
        .unwrap();
    let session_registry = owner_env
        .deploy::<SessionRegistryClientProgram>(session_registry_code_id, b"sessions".to_vec())
        .new()
        .await
        .unwrap();
    let vault = owner_env
        .deploy::<MarginVaultClientProgram>(vault_code_id, b"vault".to_vec())
        .create(OWNER.into(), session_registry.id(), token.id())
        .await
        .unwrap();
    let pool = owner_env
        .deploy::<LiquidityPoolClientProgram>(pool_code_id, b"pool".to_vec())
        .create(OWNER.into(), token.id(), 50_000)
        .await
        .unwrap();
    let config = MarketConfig {
        owner: OWNER.into(),
        asset: Asset::Btc,
        oracle_service: zero_actor_id(),
        margin_vault: vault.id(),
        liquidity_pool: pool.id(),
        session_registry: session_registry.id(),
        risk: risk_config(),
    };
    let program = owner_env
        .deploy::<PerpMarketClientProgram>(code_id, b"btc".to_vec())
        .create(config, 5_100_000_000_000, 5_000_000_000_000)
        .await
        .unwrap();

    vault.vault().authorize_market(program.id()).await.unwrap();
    pool.pool().authorize_market(program.id()).await.unwrap();

    let trader_env = owner_env.clone().with_actor_id(TRADER.into());
    let lp_env = owner_env.clone().with_actor_id(LP.into());
    let trader_token = Actor::<DemoUsdcVftClientProgram, _>::new(trader_env.clone(), token.id());
    let mut trader_token_service = trader_token.token();
    trader_token_service.mint(36_000_000_000).await.unwrap();
    trader_token_service
        .approve(vault.id(), 36_000_000_000)
        .await
        .unwrap();
    Actor::<MarginVaultClientProgram, _>::new(trader_env.clone(), vault.id())
        .vault()
        .deposit(24_000_000_000)
        .await
        .unwrap();

    let lp_token = Actor::<DemoUsdcVftClientProgram, _>::new(lp_env.clone(), token.id());
    let mut lp_token_service = lp_token.token();
    lp_token_service.mint(50_000_000_000).await.unwrap();
    lp_token_service
        .approve(pool.id(), 50_000_000_000)
        .await
        .unwrap();
    Actor::<LiquidityPoolClientProgram, _>::new(lp_env.clone(), pool.id())
        .pool()
        .deposit_liquidity(50_000_000_000)
        .await
        .unwrap();

    let trader_program = Actor::<PerpMarketClientProgram, _>::new(trader_env.clone(), program.id());
    let mut trader_market = trader_program.market();
    let long_position = trader_market
        .open_position(Side::Long, 100_000_000, 5, 12_000_000_000, 50)
        .await
        .unwrap();
    let added_long = trader_market
        .open_position(Side::Long, 50_000_000, 5, 6_000_000_000, 50)
        .await
        .unwrap();
    let open_positions = program.market().positions(TRADER.into()).await.unwrap();
    assert_eq!(open_positions.len(), 1);
    assert_eq!(added_long.id, long_position.id);
    assert_eq!(open_positions[0].id, long_position.id);
    assert_eq!(open_positions[0].position.size, 150_000_000);
    assert_eq!(open_positions[0].position.margin, 18_000_000_000);
    let account_after_open = vault.vault().account(TRADER.into()).await.unwrap();
    assert_eq!(account_after_open.free, 6_000_000_000);
    assert_eq!(account_after_open.locked, 18_000_000_000);

    let reduced_long = trader_market
        .open_position(Side::Short, 50_000_000, 5, 6_000_000_000, 50)
        .await
        .unwrap();
    assert_eq!(reduced_long.id, long_position.id);
    assert_eq!(reduced_long.position.size, 100_000_000);
    assert_eq!(reduced_long.position.margin, 12_000_000_000);
    let positions_after_reduce = program.market().positions(TRADER.into()).await.unwrap();
    assert_eq!(positions_after_reduce.len(), 1);
    assert_eq!(positions_after_reduce[0].id, long_position.id);
    let account_after_reduce = vault.vault().account(TRADER.into()).await.unwrap();
    assert_eq!(account_after_reduce.locked, 12_000_000_000);

    let flipped_short = trader_market
        .open_position(Side::Short, 150_000_000, 5, 18_000_000_000, 50)
        .await
        .unwrap();
    assert_eq!(flipped_short.id, long_position.id);
    assert_eq!(flipped_short.position.size, -50_000_000);
    let positions_after_flip = program.market().positions(TRADER.into()).await.unwrap();
    assert_eq!(positions_after_flip.len(), 1);
    assert_eq!(positions_after_flip[0].id, long_position.id);
    assert!(positions_after_flip[0].position.size < 0);

    let mut owner_market = program.market();
    let state_after_funding = owner_market.settle_funding().await.unwrap();
    assert_ne!(state_after_funding.cumulative_funding_rate_bps, 0);

    owner_market
        .update_price(10_000_000_000_000, 10_000_000_000_000)
        .await
        .unwrap();
    let liquidated = owner_market.check_liquidation(TRADER.into()).await.unwrap();
    assert!(liquidated);
    let positions_after_liquidation = program.market().positions(TRADER.into()).await.unwrap();
    assert!(positions_after_liquidation.is_empty());

    let trader_registry =
        Actor::<SessionRegistryClientProgram, _>::new(trader_env.clone(), session_registry.id());
    let mut registry_service = trader_registry.session_registry();
    registry_service
        .register_session(
            SESSION.into(),
            50,
            SessionPermissions {
                trade: true,
                add_margin: true,
                withdraw: false,
            },
        )
        .await
        .unwrap();

    owner_market
        .update_price(5_100_000_000_000, 5_000_000_000_000)
        .await
        .unwrap();

    trader_token_service.mint(12_000_000_000).await.unwrap();
    trader_token_service
        .approve(vault.id(), 12_000_000_000)
        .await
        .unwrap();
    let session_vault_actor = Actor::<MarginVaultClientProgram, _>::new(
        owner_env.clone().with_actor_id(SESSION.into()),
        vault.id(),
    );
    session_vault_actor
        .vault()
        .deposit(12_000_000_000)
        .await
        .unwrap();

    let session_env = owner_env.clone().with_actor_id(SESSION.into());
    let session_program =
        Actor::<PerpMarketClientProgram, _>::new(session_env.clone(), program.id());
    let mut session_market = session_program.market();
    let session_position = session_market
        .open_position(Side::Short, 100_000_000, 5, 12_000_000_000, 50)
        .await
        .unwrap();
    assert!(session_position.position.size < 0);
    let owner_positions = program.market().positions(TRADER.into()).await.unwrap();
    assert_eq!(owner_positions.len(), 1);
    assert_eq!(owner_positions[0].id, session_position.id);

    let closed = session_market
        .close_position(session_position.id, 100_000_000)
        .await
        .unwrap();
    assert_eq!(closed.remaining_margin, 0);
    assert_eq!(
        vault.vault().account(TRADER.into()).await.unwrap().locked,
        0
    );
}
