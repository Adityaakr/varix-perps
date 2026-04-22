use demo_usdc_vft_client::{token::Token, DemoUsdcVftClient, DemoUsdcVftClientCtors, DemoUsdcVftClientProgram};
use liquidity_pool_client::{pool::Pool, LiquidityPoolClient, LiquidityPoolClientCtors, LiquidityPoolClientProgram};
use sails_rs::{client::*, gtest::*};

const OWNER: u64 = 1;
const LP: u64 = 2;
const MARKET: u64 = 3;
const VAULT: u64 = 4;

#[tokio::test]
async fn pool_accepts_liquidity_and_reserves_capacity() {
    let system = System::new();
    system.mint_to(OWNER, 100_000_000_000_000);
    system.mint_to(LP, 100_000_000_000_000);
    system.mint_to(MARKET, 100_000_000_000_000);
    system.mint_to(VAULT, 100_000_000_000_000);
    let token_code_id = system.submit_code(demo_usdc_vft::WASM_BINARY);
    let pool_code_id = system.submit_code(liquidity_pool::WASM_BINARY);

    let owner_env = GtestEnv::new(system, OWNER.into());
    let token = owner_env
        .deploy::<DemoUsdcVftClientProgram>(token_code_id, b"token".to_vec())
        .create(OWNER.into(), "Demo USDC".into(), "dUSDC".into(), 6)
        .await
        .unwrap();
    let pool = owner_env
        .deploy::<LiquidityPoolClientProgram>(pool_code_id, b"pool".to_vec())
        .create(OWNER.into(), token.id(), 50_000)
        .await
        .unwrap();

    let lp_env = owner_env.clone().with_actor_id(LP.into());
    let lp_actor = Actor::<DemoUsdcVftClientProgram, _>::new(lp_env.clone(), token.id());
    let mut lp_token = lp_actor.token();
    lp_token.mint(5_000_000).await.unwrap();
    lp_token.approve(pool.id(), 4_000_000).await.unwrap();

    let lp_pool_actor = Actor::<LiquidityPoolClientProgram, _>::new(lp_env, pool.id());
    let mut lp_pool = lp_pool_actor.pool();
    let account = lp_pool.deposit_liquidity(4_000_000).await.unwrap();
    assert_eq!(account.shares, 4_000_000);

    let mut owner_pool = pool.pool();
    owner_pool.authorize_market(MARKET.into()).await.unwrap();

    let market_pool_actor = Actor::<LiquidityPoolClientProgram, _>::new(owner_env.clone().with_actor_id(MARKET.into()), pool.id());
    let mut market_pool = market_pool_actor.pool();
    let state = market_pool.reserve_notional(10_000_000).await.unwrap();
    assert_eq!(state.reserved_notional, 10_000_000);
    market_pool.release_notional(2_000_000).await.unwrap();

    let payout = market_pool.pay_out_to_vault(VAULT.into(), 500_000).await.unwrap();
    assert_eq!(payout.total_liquidity, 4_000_000);
    assert_eq!(token.token().balance_of(VAULT.into()).await.unwrap(), 500_000);
}
