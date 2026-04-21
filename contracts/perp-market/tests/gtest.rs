use perp_market_client::{
    Asset, MarketConfig, MarketRiskConfig, PerpMarketClient, PerpMarketClientCtors,
    PerpMarketClientProgram, Side, market::*,
};
use sails_rs::{client::*, gtest::*};
use session_registry_client::{
    session_registry::SessionRegistry,
    SessionPermissions,
    SessionRegistryClient,
    SessionRegistryClientCtors,
    SessionRegistryClientProgram,
};

const OWNER: u64 = 1;
const TRADER: u64 = 42;
const SESSION: u64 = 99;

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
    let code_id = system.submit_code(perp_market::WASM_BINARY);
    let session_registry_code_id = system.submit_code(session_registry::WASM_BINARY);

    let owner_env = GtestEnv::new(system, OWNER.into());
    let session_registry = owner_env
        .deploy::<SessionRegistryClientProgram>(session_registry_code_id, b"sessions".to_vec())
        .new()
        .await
        .unwrap();
    let config = MarketConfig {
        owner: OWNER.into(),
        asset: Asset::Btc,
        oracle_service: None,
        margin_vault: None,
        session_registry: Some(session_registry.id()),
        risk: risk_config(),
    };
    let program = owner_env
        .deploy::<PerpMarketClientProgram>(code_id, b"btc".to_vec())
        .create(config, 5_100_000_000_000, 5_000_000_000_000)
        .await
        .unwrap();

    let trader_env = owner_env.clone().with_actor_id(TRADER.into());
    let trader_program = Actor::<PerpMarketClientProgram, _>::new(trader_env.clone(), program.id());
    let mut trader_market = trader_program.market();
    trader_market
        .open_position(Side::Long, 100_000_000, 5, 12_000_000_000, 50)
        .await
        .unwrap();

    let mut owner_market = program.market();
    let state_after_funding = owner_market.settle_funding().await.unwrap();
    assert_ne!(state_after_funding.cumulative_funding_rate_bps, 0);

    owner_market
        .update_price(4_000_000_000_000, 4_000_000_000_000)
        .await
        .unwrap();
    let liquidated = owner_market.check_liquidation(TRADER.into()).await.unwrap();
    assert!(liquidated);
    let position = program.market().position(TRADER.into()).await.unwrap();
    assert!(position.is_none());

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

    let session_env = owner_env.clone().with_actor_id(SESSION.into());
    let session_program = Actor::<PerpMarketClientProgram, _>::new(session_env.clone(), program.id());
    let mut session_market = session_program.market();
    let session_position = session_market
        .open_position(Side::Short, 100_000_000, 5, 12_000_000_000, 50)
        .await
        .unwrap();
    assert!(session_position.size < 0);
    let owner_position = program.market().position(TRADER.into()).await.unwrap();
    assert!(owner_position.is_some());

    let closed = session_market.close_position(100_000_000).await.unwrap();
    assert_eq!(closed.remaining_margin, 0);
}
