use ed25519_dalek::{Signer, SigningKey};
use oracle_service_client::{
    Asset, OracleServiceClient, OracleServiceClientCtors, OracleServiceClientProgram, oracle::*,
};
use sails_rs::{client::*, gtest::*, prelude::Encode};

const OWNER: u64 = 1;
const RELAYER: u64 = 9;

#[tokio::test]
async fn oracle_accepts_signed_price_from_whitelisted_relayer() {
    let system = System::new();
    system.mint_to(OWNER, 100_000_000_000_000);
    system.mint_to(RELAYER, 100_000_000_000_000);
    let code_id = system.submit_code(oracle_service::WASM_BINARY);

    let owner_env = GtestEnv::new(system, OWNER.into());
    let program = owner_env
        .deploy::<OracleServiceClientProgram>(code_id, b"oracle".to_vec())
        .create(OWNER.into())
        .await
        .unwrap();

    let signing_key = SigningKey::from_bytes(&[7u8; 32]);
    let verifying_key = signing_key.verifying_key().to_bytes();

    let mut owner_oracle = program.oracle();
    owner_oracle
        .configure_relayer(RELAYER.into(), Some(verifying_key))
        .await
        .unwrap();

    let relayer_env = owner_env.clone().with_actor_id(RELAYER.into());
    let relayer_program =
        Actor::<OracleServiceClientProgram, _>::new(relayer_env.clone(), program.id());
    let mut relayer_oracle = relayer_program.oracle();

    let payload = [
        Asset::Btc.encode(),
        60_000u128.encode(),
        1u64.encode(),
        relayer_env.actor_id().encode(),
    ]
    .concat();
    let signature = signing_key.sign(&payload).to_bytes().to_vec();

    let quote = relayer_oracle
        .submit_price(Asset::Btc, 60_000, 1, signature)
        .await
        .unwrap();
    assert_eq!(quote.price, 60_000);
    assert_eq!(quote.timestamp, 1);

    let stored = program.oracle().quote(Asset::Btc).await.unwrap();
    assert_eq!(stored.unwrap().price, 60_000);
}
