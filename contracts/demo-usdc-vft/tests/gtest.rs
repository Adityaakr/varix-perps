use demo_usdc_vft_client::{
    token::Token,
    DemoUsdcVftClient, DemoUsdcVftClientCtors, DemoUsdcVftClientProgram,
};
use sails_rs::{client::*, gtest::*};

const OWNER: u64 = 1;
const ALICE: u64 = 2;
const BOB: u64 = 3;
const SPENDER: u64 = 4;

#[tokio::test]
async fn demo_vft_mints_transfers_and_uses_allowances() {
    let system = System::new();
    system.mint_to(OWNER, 100_000_000_000_000);
    system.mint_to(ALICE, 100_000_000_000_000);
    system.mint_to(BOB, 100_000_000_000_000);
    system.mint_to(SPENDER, 100_000_000_000_000);
    let code_id = system.submit_code(demo_usdc_vft::WASM_BINARY);

    let owner_env = GtestEnv::new(system, OWNER.into());
    let program = owner_env
        .deploy::<DemoUsdcVftClientProgram>(code_id, b"demo-usdc".to_vec())
        .create(OWNER.into(), "Demo USDC".into(), "dUSDC".into(), 6)
        .await
        .unwrap();

    let alice = Actor::<DemoUsdcVftClientProgram, _>::new(owner_env.clone().with_actor_id(ALICE.into()), program.id());
    let bob = Actor::<DemoUsdcVftClientProgram, _>::new(owner_env.clone().with_actor_id(BOB.into()), program.id());
    let spender = Actor::<DemoUsdcVftClientProgram, _>::new(owner_env.clone().with_actor_id(SPENDER.into()), program.id());

    let mut alice_token = alice.token();
    assert_eq!(alice_token.mint(5_000_000).await.unwrap(), 5_000_000);
    assert_eq!(program.token().balance_of(ALICE.into()).await.unwrap(), 5_000_000);

    alice_token.transfer(BOB.into(), 1_250_000).await.unwrap();
    assert_eq!(program.token().balance_of(BOB.into()).await.unwrap(), 1_250_000);

    alice_token.approve(SPENDER.into(), 2_000_000).await.unwrap();
    let mut spender_token = spender.token();
    spender_token
        .transfer_from(ALICE.into(), BOB.into(), 750_000)
        .await
        .unwrap();
    assert_eq!(program.token().allowance(ALICE.into(), SPENDER.into()).await.unwrap(), 1_250_000);
    assert_eq!(program.token().balance_of(BOB.into()).await.unwrap(), 2_000_000);

    let mut owner_token = program.token();
    owner_token.mint_to(BOB.into(), 500_000).await.unwrap();
    assert_eq!(program.token().total_supply().await.unwrap(), 5_500_000);
    assert_eq!(bob.token().symbol().await.unwrap(), "dUSDC");
}
