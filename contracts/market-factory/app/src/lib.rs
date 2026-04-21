#![no_std]

extern crate alloc;

use alloc::vec::Vec;
use sails_rs::{cell::RefCell, collections::BTreeMap, gstd::msg, prelude::*};
use varix_shared::Asset;

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum FactoryError {
    MarketAlreadyRegistered,
    MarketNotRegistered,
    Unauthorized,
}

#[sails_rs::event]
#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum FactoryEvent {
    MarketCodeConfigured {
        code_id: [u8; 32],
    },
    MarketRegistered {
        asset: Asset,
        market: ActorId,
    },
    MarketUnregistered {
        asset: Asset,
    },
}

#[derive(Default)]
pub struct FactoryState {
    owner: ActorId,
    market_code_id: Option<[u8; 32]>,
    markets: BTreeMap<Asset, ActorId>,
}

pub struct FactoryService<'a> {
    state: &'a RefCell<FactoryState>,
}

impl<'a> FactoryService<'a> {
    pub fn new(state: &'a RefCell<FactoryState>) -> Self {
        Self { state }
    }

    fn require_owner(state: &FactoryState) -> Result<(), FactoryError> {
        if msg::source() == state.owner {
            Ok(())
        } else {
            Err(FactoryError::Unauthorized)
        }
    }
}

#[sails_rs::service(events = FactoryEvent)]
impl FactoryService<'_> {
    #[export(unwrap_result)]
    pub fn configure_market_code(&mut self, code_id: [u8; 32]) -> Result<(), FactoryError> {
        let mut state = self.state.borrow_mut();
        FactoryService::require_owner(&state)?;
        state.market_code_id = Some(code_id);
        self.emit_event(FactoryEvent::MarketCodeConfigured { code_id })
            .expect("event emission should succeed");
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn register_market(&mut self, asset: Asset, market: ActorId) -> Result<(), FactoryError> {
        let mut state = self.state.borrow_mut();
        FactoryService::require_owner(&state)?;
        if state.markets.insert(asset, market).is_some() {
            return Err(FactoryError::MarketAlreadyRegistered);
        }
        self.emit_event(FactoryEvent::MarketRegistered { asset, market })
            .expect("event emission should succeed");
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn unregister_market(&mut self, asset: Asset) -> Result<(), FactoryError> {
        let mut state = self.state.borrow_mut();
        FactoryService::require_owner(&state)?;
        if state.markets.remove(&asset).is_none() {
            return Err(FactoryError::MarketNotRegistered);
        }
        self.emit_event(FactoryEvent::MarketUnregistered { asset })
            .expect("event emission should succeed");
        Ok(())
    }

    #[export]
    pub fn market(&self, asset: Asset) -> Option<ActorId> {
        self.state.borrow().markets.get(&asset).copied()
    }

    #[export]
    pub fn markets(&self) -> Vec<(Asset, ActorId)> {
        self.state
            .borrow()
            .markets
            .iter()
            .map(|(asset, actor)| (*asset, *actor))
            .collect()
    }
}

pub struct Program {
    state: RefCell<FactoryState>,
}

#[sails_rs::program]
impl Program {
    pub fn create(owner: ActorId) -> Self {
        Self {
            state: RefCell::new(FactoryState {
                owner,
                ..Default::default()
            }),
        }
    }

    pub fn factory(&self) -> FactoryService<'_> {
        FactoryService::new(&self.state)
    }
}
