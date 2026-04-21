#![no_std]

extern crate alloc;

use alloc::vec::Vec;
use sails_rs::{cell::RefCell, collections::BTreeMap, gstd::msg, prelude::*};

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum SchedulerError {
    Unauthorized,
}

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct FundingMarketConfig {
    pub market: ActorId,
    pub interval_blocks: u32,
    pub enabled: bool,
}

#[derive(Default)]
pub struct SchedulerState {
    owner: ActorId,
    markets: BTreeMap<ActorId, FundingMarketConfig>,
}

pub struct FundingSchedulerService<'a> {
    state: &'a RefCell<SchedulerState>,
}

impl<'a> FundingSchedulerService<'a> {
    pub fn new(state: &'a RefCell<SchedulerState>) -> Self {
        Self { state }
    }
}

#[sails_rs::service]
impl FundingSchedulerService<'_> {
    #[export(unwrap_result)]
    pub fn upsert_market(
        &mut self,
        market: ActorId,
        interval_blocks: u32,
        enabled: bool,
    ) -> Result<FundingMarketConfig, SchedulerError> {
        let mut state = self.state.borrow_mut();
        if msg::source() != state.owner {
            return Err(SchedulerError::Unauthorized);
        }
        let config = FundingMarketConfig {
            market,
            interval_blocks,
            enabled,
        };
        state.markets.insert(market, config.clone());
        Ok(config)
    }

    pub fn market(&self, market: ActorId) -> Option<FundingMarketConfig> {
        self.state.borrow().markets.get(&market).cloned()
    }

    pub fn markets(&self) -> Vec<FundingMarketConfig> {
        self.state.borrow().markets.values().cloned().collect()
    }
}

pub struct Program {
    state: RefCell<SchedulerState>,
}

#[sails_rs::program]
impl Program {
    pub fn create(owner: ActorId) -> Self {
        Self {
            state: RefCell::new(SchedulerState {
                owner,
                ..Default::default()
            }),
        }
    }

    pub fn funding_scheduler(&self) -> FundingSchedulerService<'_> {
        FundingSchedulerService::new(&self.state)
    }
}
