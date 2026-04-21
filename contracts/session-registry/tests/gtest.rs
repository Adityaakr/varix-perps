use sails_rs::{client::*, gtest::*};
use session_registry_client::{
    SessionAction, SessionPermissions, SessionRegistryClient, SessionRegistryClientCtors,
    SessionRegistryClientProgram, session_registry::*,
};

const TRADER: u64 = 42;
const OTHER_TRADER: u64 = 7;
const SESSION_ONE: u64 = 1001;
const SESSION_TWO: u64 = 1002;

fn permissions() -> SessionPermissions {
    SessionPermissions {
        trade: true,
        add_margin: true,
        withdraw: false,
    }
}

#[tokio::test]
async fn session_registry_registers_replaces_revokes_and_expires() {
    let system = System::new();
    system.mint_to(TRADER, 100_000_000_000_000);
    system.mint_to(OTHER_TRADER, 100_000_000_000_000);
    let code_id = system.submit_code(session_registry::WASM_BINARY);

    let env = GtestEnv::new(system, TRADER.into());
    let program = env
        .deploy::<SessionRegistryClientProgram>(code_id, b"sessions".to_vec())
        .new()
        .await
        .unwrap();

    let trader_env = env.clone().with_actor_id(TRADER.into());
    let trader_program =
        Actor::<SessionRegistryClientProgram, _>::new(trader_env.clone(), program.id());
    let mut trader_sessions = trader_program.session_registry();
    let first_expiry = trader_env.system().block_height() + 20;

    let initial = trader_sessions
        .register_session(SESSION_ONE.into(), first_expiry, permissions())
        .await
        .unwrap();
    assert_eq!(initial.session_key, SESSION_ONE.into());

    let query = program.session_registry();
    assert!(query
        .validate(TRADER.into(), SESSION_ONE.into(), SessionAction::Trade)
        .await
        .unwrap());
    assert!(!query
        .validate(TRADER.into(), SESSION_ONE.into(), SessionAction::Withdraw)
        .await
        .unwrap());

    let second_expiry = trader_env.system().block_height() + 20;
    let replaced = trader_sessions
        .register_session(SESSION_TWO.into(), second_expiry, permissions())
        .await
        .unwrap();
    assert_eq!(replaced.session_key, SESSION_TWO.into());
    assert!(query.owner_for(SESSION_ONE.into()).await.unwrap().is_none());
    assert_eq!(query.owner_for(SESSION_TWO.into()).await.unwrap(), Some(TRADER.into()));

    let other_env = env.clone().with_actor_id(OTHER_TRADER.into());
    let other_program =
        Actor::<SessionRegistryClientProgram, _>::new(other_env.clone(), program.id());
    let mut other_sessions = other_program.session_registry();
    let error = other_sessions
        .register_session(SESSION_TWO.into(), trader_env.system().block_height() + 20, permissions())
        .await;
    assert!(error.is_err());
    assert_eq!(query.owner_for(SESSION_TWO.into()).await.unwrap(), Some(TRADER.into()));

    trader_sessions.revoke_session(SESSION_TWO.into()).await.unwrap();
    assert!(query.owner_for(SESSION_TWO.into()).await.unwrap().is_none());

    let short_expiry = trader_env.system().block_height() + 2;
    trader_sessions
        .register_session(SESSION_ONE.into(), short_expiry, permissions())
        .await
        .unwrap();
    trader_env.system().run_next_block();
    trader_env.system().run_next_block();
    trader_env.system().run_next_block();

    assert!(!query
        .validate(TRADER.into(), SESSION_ONE.into(), SessionAction::Trade)
        .await
        .unwrap());
    assert!(query.active_session(TRADER.into()).await.unwrap().is_none());
}
