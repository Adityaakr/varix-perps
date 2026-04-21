#![no_std]

extern crate alloc;

use alloc::vec::Vec;
use sails_rs::{cell::RefCell, collections::BTreeMap, gstd::msg, prelude::*};

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum LiquidationManagerError {
    Unauthorized,
}

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct ManagedMarket {
    pub market: ActorId,
    pub scan_delay_blocks: u32,
    pub enabled: bool,
}

#[derive(Default)]
pub struct LiquidationManagerState {
    owner: ActorId,
    markets: BTreeMap<ActorId, ManagedMarket>,
}

pub struct LiquidationManagerService<'a> {
    state: &'a RefCell<LiquidationManagerState>,
}

impl<'a> LiquidationManagerService<'a> {
    pub fn new(state: &'a RefCell<LiquidationManagerState>) -> Self {
        Self { state }
    }
}

#[sails_rs::service]
impl LiquidationManagerService<'_> {
    #[export(unwrap_result)]
    pub fn upsert_market(
        &mut self,
        market: ActorId,
        scan_delay_blocks: u32,
        enabled: bool,
    ) -> Result<ManagedMarket, LiquidationManagerError> {
        let mut state = self.state.borrow_mut();
        if msg::source() != state.owner {
            return Err(LiquidationManagerError::Unauthorized);
        }
        let managed = ManagedMarket {
            market,
            scan_delay_blocks,
            enabled,
        };
        state.markets.insert(market, managed.clone());
        Ok(managed)
    }

    pub fn market(&self, market: ActorId) -> Option<ManagedMarket> {
        self.state.borrow().markets.get(&market).cloned()
    }

    pub fn markets(&self) -> Vec<ManagedMarket> {
        self.state.borrow().markets.values().cloned().collect()
    }
}

pub struct Program {
    state: RefCell<LiquidationManagerState>,
}

#[sails_rs::program]
impl Program {
    pub fn create(owner: ActorId) -> Self {
        Self {
            state: RefCell::new(LiquidationManagerState {
                owner,
                ..Default::default()
            }),
        }
    }

    pub fn liquidation_manager(&self) -> LiquidationManagerService<'_> {
        LiquidationManagerService::new(&self.state)
    }
}
