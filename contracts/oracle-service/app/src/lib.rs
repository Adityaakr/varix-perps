#![no_std]

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sails_rs::{cell::RefCell, collections::BTreeMap, gstd::msg, prelude::*};
use varix_shared::{within_deviation, Asset, OracleQuote};

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum OracleError {
    InvalidSignature,
    InvalidSignatureLength,
    InvalidVerifyingKey,
    PriceDeviationTooLarge,
    PriceOutdated,
    RelayerNotAuthorized,
    Unauthorized,
}

#[sails_rs::event]
#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum OracleEvent {
    RelayerConfigured {
        relayer: ActorId,
        enabled: bool,
    },
    PriceSubmitted {
        asset: Asset,
        price: u128,
        timestamp: u64,
        relayer: ActorId,
    },
}

#[derive(Default)]
pub struct OracleState {
    owner: ActorId,
    max_deviation_bps: u16,
    relayers: BTreeMap<ActorId, [u8; 32]>,
    quotes: BTreeMap<Asset, OracleQuote>,
}

pub struct OracleService<'a> {
    state: &'a RefCell<OracleState>,
}

impl<'a> OracleService<'a> {
    pub fn new(state: &'a RefCell<OracleState>) -> Self {
        Self { state }
    }

    fn require_owner(state: &OracleState) -> Result<(), OracleError> {
        if msg::source() == state.owner {
            Ok(())
        } else {
            Err(OracleError::Unauthorized)
        }
    }

    fn quote_payload(asset: Asset, price: u128, timestamp: u64) -> Vec<u8> {
        [
            asset.encode(),
            price.encode(),
            timestamp.encode(),
            msg::source().encode(),
        ]
        .concat()
    }
}

#[sails_rs::service(events = OracleEvent)]
impl OracleService<'_> {
    #[export(unwrap_result)]
    pub fn configure_relayer(
        &mut self,
        relayer: ActorId,
        verifying_key: Option<[u8; 32]>,
    ) -> Result<(), OracleError> {
        let mut state = self.state.borrow_mut();
        OracleService::require_owner(&state)?;
        let enabled = if let Some(key) = verifying_key {
            state.relayers.insert(relayer, key);
            true
        } else {
            state.relayers.remove(&relayer);
            false
        };
        self.emit_event(OracleEvent::RelayerConfigured { relayer, enabled })
            .expect("event emission should succeed");
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn submit_price(
        &mut self,
        asset: Asset,
        price: u128,
        timestamp: u64,
        sig: Vec<u8>,
    ) -> Result<OracleQuote, OracleError> {
        let relayer = msg::source();
        let mut state = self.state.borrow_mut();
        let verifying_key = state
            .relayers
            .get(&relayer)
            .copied()
            .ok_or(OracleError::RelayerNotAuthorized)?;

        if let Some(existing) = state.quotes.get(&asset) {
            if timestamp <= existing.timestamp {
                return Err(OracleError::PriceOutdated);
            }
            // Circuit breaker: reject a submission that deviates further than the
            // configured tolerance from the last accepted price for this asset.
            if state.max_deviation_bps != 0
                && !within_deviation(existing.price, price, state.max_deviation_bps)
            {
                return Err(OracleError::PriceDeviationTooLarge);
            }
        }

        let verifying_key =
            VerifyingKey::from_bytes(&verifying_key).map_err(|_| OracleError::InvalidVerifyingKey)?;
        let signature = Signature::try_from(sig.as_slice())
            .map_err(|_| OracleError::InvalidSignatureLength)?;
        let payload = OracleService::quote_payload(asset, price, timestamp);
        verifying_key
            .verify(&payload, &signature)
            .map_err(|_| OracleError::InvalidSignature)?;

        let quote = OracleQuote { price, timestamp };
        state.quotes.insert(asset, quote);
        self.emit_event(OracleEvent::PriceSubmitted {
            asset,
            price,
            timestamp,
            relayer,
        })
        .expect("event emission should succeed");
        Ok(quote)
    }

    /// Owner-only: bound how far each signed price submission may move from the
    /// previous accepted price for the same asset, in basis points. `0` disables.
    #[export(unwrap_result)]
    pub fn set_deviation_guard(&mut self, max_deviation_bps: u16) -> Result<u16, OracleError> {
        let mut state = self.state.borrow_mut();
        OracleService::require_owner(&state)?;
        state.max_deviation_bps = max_deviation_bps;
        Ok(state.max_deviation_bps)
    }

    #[export]
    pub fn deviation_guard(&self) -> u16 {
        self.state.borrow().max_deviation_bps
    }

    #[export]
    pub fn quote(&self, asset: Asset) -> Option<OracleQuote> {
        self.state.borrow().quotes.get(&asset).copied()
    }
}

pub struct Program {
    state: RefCell<OracleState>,
}

#[sails_rs::program]
impl Program {
    pub fn create(owner: ActorId) -> Self {
        Self {
            state: RefCell::new(OracleState {
                owner,
                ..Default::default()
            }),
        }
    }

    pub fn oracle(&self) -> OracleService<'_> {
        OracleService::new(&self.state)
    }
}
