use demo_usdc_vft_client::{token::Token as TokenCalls, DemoUsdcVftClient, DemoUsdcVftClientCtors, DemoUsdcVftClientProgram};
use margin_vault_client::{
    MarginVaultClient, MarginVaultClientCtors, MarginVaultClientProgram, vault::*,
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
const MARKET: u64 = 77;
const SESSION: u64 = 99;

#[tokio::test]
async fn vault_handles_deposit_withdraw_and_lock_flow() {
    let system = System::new();
    system.mint_to(OWNER, 100_000_000_000_000);
    system.mint_to(TRADER, 100_000_000_000_000);
    system.mint_to(MARKET, 100_000_000_000_000);
    system.mint_to(SESSION, 100_000_000_000_000);
    let token_code_id = system.submit_code(demo_usdc_vft::WASM_BINARY);
    let code_id = system.submit_code(margin_vault::WASM_BINARY);
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
    let program = owner_env
        .deploy::<MarginVaultClientProgram>(code_id, b"vault".to_vec())
        .create(OWNER.into(), session_registry.id(), token.id())
        .await
        .unwrap();

    let trader_env = owner_env.clone().with_actor_id(TRADER.into());
    let market_env = owner_env.clone().with_actor_id(MARKET.into());

    let trader_token = Actor::<DemoUsdcVftClientProgram, _>::new(trader_env.clone(), token.id());
    let mut trader_token_service = trader_token.token();
    trader_token_service.mint(1_000_000).await.unwrap();
    trader_token_service.approve(program.id(), 1_000_000).await.unwrap();

    let trader_program =
        Actor::<MarginVaultClientProgram, _>::new(trader_env.clone(), program.id());
    let mut trader_vault = trader_program.vault();
    let deposited = trader_vault.deposit(1_000_000).await.unwrap();
    assert_eq!(deposited.free, 1_000_000);
    assert_eq!(deposited.locked, 0);

    let mut owner_vault = program.vault();
    owner_vault.authorize_market(MARKET.into()).await.unwrap();

    let market_program =
        Actor::<MarginVaultClientProgram, _>::new(market_env.clone(), program.id());
    let mut market_vault = market_program.vault();
    let locked = market_vault
        .lock_margin(TRADER.into(), 400_000)
        .await
        .unwrap();
    assert_eq!(locked.free, 600_000);
    assert_eq!(locked.locked, 400_000);

    let mut trader_vault = trader_program.vault();
    let after_withdraw = trader_vault.withdraw(100_000).await.unwrap();
    assert_eq!(after_withdraw.free, 500_000);
    assert_eq!(after_withdraw.locked, 400_000);

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
                withdraw: true,
            },
        )
        .await
        .unwrap();

    let session_env = owner_env.clone().with_actor_id(SESSION.into());
    let session_program =
        Actor::<MarginVaultClientProgram, _>::new(session_env.clone(), program.id());
    let mut session_vault = session_program.vault();
    trader_token_service.approve(program.id(), 50_000).await.unwrap();
    let session_deposit = session_vault.deposit(50_000).await.unwrap();
    assert_eq!(session_deposit.free, 550_000);

    let session_withdraw = session_vault.withdraw(25_000).await.unwrap();
    assert_eq!(session_withdraw.free, 525_000);

    assert_eq!(token.token().balance_of(program.id()).await.unwrap(), 925_000);
}
