#![no_std]

extern crate alloc;

use sails_rs::{
    cell::RefCell,
    client::Program as _,
    collections::BTreeMap,
    gstd::{exec, msg},
    prelude::*,
};
use session_registry_client::{
    session_registry::SessionRegistry as SessionRegistryCalls,
    SessionAction as SessionRegistryAction,
    SessionRegistryClient,
    SessionRegistryClientProgram,
};
use varix_shared::{
    collateral_for_leverage, margin_requirement, notional_to_collateral, pnl_to_collateral, Asset,
    BPS_DIVISOR, MarketRiskConfig, MarketSnapshot, Position, Side,
};

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct ClosedPosition {
    pub realized_pnl: i128,
    pub funding_paid: i128,
    pub remaining_margin: u128,
}

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum MarketError {
    InternalOnly,
    InvalidLeverage,
    InvalidMargin,
    InvalidPrice,
    InvalidSize,
    NoPosition,
    PositionAlreadyExists,
    SessionRegistryQueryFailed,
    SizeTooLarge,
    Unauthorized,
}

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct MarketConfig {
    pub owner: ActorId,
    pub asset: Asset,
    pub oracle_service: Option<ActorId>,
    pub margin_vault: Option<ActorId>,
    pub session_registry: Option<ActorId>,
    pub risk: MarketRiskConfig,
}

#[sails_rs::event]
#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum MarketEvent {
    PriceUpdated {
        mark_price: u128,
        index_price: u128,
    },
    PositionOpened {
        trader: ActorId,
        position: Position,
    },
    PositionClosed {
        trader: ActorId,
        close: ClosedPosition,
    },
    MarginAdded {
        trader: ActorId,
        new_margin: u128,
    },
    FundingSettled {
        funding_rate_bps: i128,
        cumulative_funding_rate_bps: i128,
        block: u32,
    },
    Liquidated {
        trader: ActorId,
        mark_price: u128,
        equity: i128,
        maintenance_margin: u128,
    },
}

pub struct PerpMarketState {
    config: MarketConfig,
    snapshot: MarketSnapshot,
    last_funding_block: u32,
    positions: BTreeMap<ActorId, Position>,
}

pub struct MarketService<'a> {
    state: &'a RefCell<PerpMarketState>,
}

impl<'a> MarketService<'a> {
    const SERVICE_NAME: &'static str = "MarketService";
    const FUNDING_METHOD: &'static str = "SettleFunding";
    const LIQUIDATION_METHOD: &'static str = "CheckLiquidation";

    pub fn new(state: &'a RefCell<PerpMarketState>) -> Self {
        Self { state }
    }

    fn require_owner(state: &PerpMarketState) -> Result<(), MarketError> {
        if msg::source() == state.config.owner {
            Ok(())
        } else {
            Err(MarketError::Unauthorized)
        }
    }

    fn require_internal_or_owner(state: &PerpMarketState) -> Result<(), MarketError> {
        if msg::source() == exec::program_id() || msg::source() == state.config.owner {
            Ok(())
        } else {
            Err(MarketError::Unauthorized)
        }
    }

    fn funding_payload() -> Vec<u8> {
        [Self::SERVICE_NAME.encode(), Self::FUNDING_METHOD.encode()].concat()
    }

    fn liquidation_payload(trader: ActorId) -> Vec<u8> {
        [
            Self::SERVICE_NAME.encode(),
            Self::LIQUIDATION_METHOD.encode(),
            trader.encode(),
        ]
        .concat()
    }

    fn schedule_payload(payload: Vec<u8>, delay: u32) {
        let gas = exec::gas_available().saturating_mul(9).saturating_div(10);
        msg::send_bytes_with_gas_delayed(exec::program_id(), payload, gas, 0, delay)
            .expect("delayed self message should schedule");
    }

    fn current_block() -> u32 {
        exec::block_height()
    }

    fn notional(position: &Position, mark_price: u128) -> Result<u128, MarketError> {
        notional_to_collateral(position.size.unsigned_abs(), mark_price).ok_or(MarketError::InvalidSize)
    }

    fn funding_delta(position: &Position, current_rate: i128, mark_price: u128) -> Result<i128, MarketError> {
        let notional = Self::notional(position, mark_price)? as i128;
        let delta_rate = current_rate - position.last_funding_rate_bps;
        let raw = notional
            .checked_mul(delta_rate)
            .ok_or(MarketError::InvalidMargin)?
            .checked_div(BPS_DIVISOR as i128)
            .ok_or(MarketError::InvalidMargin)?;

        Ok(if position.size > 0 { raw } else { -raw })
    }

    fn equity(position: &Position, mark_price: u128, current_rate: i128) -> Result<i128, MarketError> {
        let pnl = pnl_to_collateral(position.size, position.entry_price, mark_price)
            .ok_or(MarketError::InvalidPrice)?;
        let funding = Self::funding_delta(position, current_rate, mark_price)?;
        Ok(position.margin as i128 + pnl - funding)
    }

    fn maintenance_margin(position: &Position, mark_price: u128, bps: u16) -> Result<u128, MarketError> {
        let notional = Self::notional(position, mark_price)?;
        margin_requirement(notional, bps).ok_or(MarketError::InvalidMargin)
    }

    fn apply_close(
        position: &mut Position,
        close_size: u128,
        mark_price: u128,
        cumulative_funding_rate_bps: i128,
    ) -> Result<ClosedPosition, MarketError> {
        let original_abs = position.size.unsigned_abs();
        if close_size == 0 {
            return Err(MarketError::InvalidSize);
        }
        if close_size > original_abs {
            return Err(MarketError::SizeTooLarge);
        }

        let proportion_margin = position
            .margin
            .checked_mul(close_size)
            .ok_or(MarketError::InvalidMargin)?
            .checked_div(original_abs)
            .ok_or(MarketError::InvalidMargin)?;
        let signed_close = if position.size > 0 {
            close_size as i128
        } else {
            -(close_size as i128)
        };
        let realized_pnl = pnl_to_collateral(signed_close, position.entry_price, mark_price)
            .ok_or(MarketError::InvalidPrice)?;
        let funding_paid = Self::funding_delta(position, cumulative_funding_rate_bps, mark_price)?
            .checked_mul(close_size as i128)
            .ok_or(MarketError::InvalidMargin)?
            .checked_div(original_abs as i128)
            .ok_or(MarketError::InvalidMargin)?;

        position.margin = position
            .margin
            .checked_sub(proportion_margin)
            .ok_or(MarketError::InvalidMargin)?;
        position.size -= signed_close;
        position.last_funding_rate_bps = cumulative_funding_rate_bps;

        Ok(ClosedPosition {
            realized_pnl,
            funding_paid,
            remaining_margin: position.margin,
        })
    }

    fn funding_rate(mark_price: u128, index_price: u128, max_velocity_bps: i16) -> Result<i128, MarketError> {
        if index_price == 0 {
            return Err(MarketError::InvalidPrice);
        }
        let premium_bps = ((mark_price as i128 - index_price as i128) * BPS_DIVISOR as i128)
            .checked_div(index_price as i128)
            .ok_or(MarketError::InvalidPrice)?;
        Ok(premium_bps.clamp(-(max_velocity_bps as i128), max_velocity_bps as i128))
    }

    async fn resolve_trader(
        &self,
        action: SessionRegistryAction,
    ) -> Result<ActorId, MarketError> {
        let caller = msg::source();
        let session_registry = self.state.borrow().config.session_registry;
        let Some(session_registry) = session_registry else {
            return Ok(caller);
        };

        let session_registry = SessionRegistryClientProgram::client(session_registry);
        let session_registry = session_registry.session_registry();
        let owner = session_registry
            .owner_for(caller)
            .await
            .map_err(|_| MarketError::SessionRegistryQueryFailed)?;
        let Some(owner) = owner else {
            return Ok(caller);
        };

        let valid = session_registry
            .validate(owner, caller, action)
            .await
            .map_err(|_| MarketError::SessionRegistryQueryFailed)?;
        if valid {
            Ok(owner)
        } else {
            Err(MarketError::Unauthorized)
        }
    }
}

#[sails_rs::service(events = MarketEvent)]
impl MarketService<'_> {
    #[export(unwrap_result)]
    pub fn update_price(&mut self, mark_price: u128, index_price: u128) -> Result<MarketSnapshot, MarketError> {
        let mut state = self.state.borrow_mut();
        MarketService::require_owner(&state)?;
        if mark_price == 0 || index_price == 0 {
            return Err(MarketError::InvalidPrice);
        }
        state.snapshot.mark_price = mark_price;
        state.snapshot.index_price = index_price;
        self.emit_event(MarketEvent::PriceUpdated {
            mark_price,
            index_price,
        })
        .expect("event emission should succeed");
        Ok(state.snapshot)
    }

    #[export(unwrap_result)]
    pub async fn open_position(
        &mut self,
        side: Side,
        size: u128,
        leverage: u8,
        margin: u128,
        _max_slippage_bps: u16,
    ) -> Result<Position, MarketError> {
        let trader = self.resolve_trader(SessionRegistryAction::Trade).await?;
        let mut state = self.state.borrow_mut();
        if size == 0 {
            return Err(MarketError::InvalidSize);
        }
        if leverage == 0 || leverage > state.config.risk.max_leverage {
            return Err(MarketError::InvalidLeverage);
        }
        if state.snapshot.mark_price == 0 {
            return Err(MarketError::InvalidPrice);
        }
        if state.positions.contains_key(&trader) {
            return Err(MarketError::PositionAlreadyExists);
        }

        let notional = notional_to_collateral(size, state.snapshot.mark_price)
            .ok_or(MarketError::InvalidSize)?;
        let required_margin = collateral_for_leverage(notional, leverage)
            .ok_or(MarketError::InvalidLeverage)?;
        if margin < required_margin {
            return Err(MarketError::InvalidMargin);
        }

        let signed_size = side.direction()
            .checked_mul(size as i128)
            .ok_or(MarketError::InvalidSize)?;
        let position = Position {
            size: signed_size,
            entry_price: state.snapshot.mark_price,
            margin,
            leverage,
            last_funding_rate_bps: state.snapshot.cumulative_funding_rate_bps,
            opened_at: MarketService::current_block() as u64,
        };
        if side == Side::Long {
            state.snapshot.open_interest_long = state
                .snapshot
                .open_interest_long
                .saturating_add(size);
        } else {
            state.snapshot.open_interest_short = state
                .snapshot
                .open_interest_short
                .saturating_add(size);
        }

        state.positions.insert(trader, position.clone());
        MarketService::schedule_payload(
            MarketService::liquidation_payload(trader),
            state.config.risk.liquidation_delay_blocks,
        );
        self.emit_event(MarketEvent::PositionOpened {
            trader,
            position: position.clone(),
        })
        .expect("event emission should succeed");
        Ok(position)
    }

    #[export(unwrap_result)]
    pub async fn add_margin(&mut self, amount: u128) -> Result<Position, MarketError> {
        if amount == 0 {
            return Err(MarketError::InvalidMargin);
        }
        let trader = self.resolve_trader(SessionRegistryAction::AddMargin).await?;
        let mut state = self.state.borrow_mut();
        let position = state.positions.get_mut(&trader).ok_or(MarketError::NoPosition)?;
        position.margin = position.margin.saturating_add(amount);
        self.emit_event(MarketEvent::MarginAdded {
            trader,
            new_margin: position.margin,
        })
        .expect("event emission should succeed");
        Ok(position.clone())
    }

    #[export(unwrap_result)]
    pub async fn close_position(&mut self, size: u128) -> Result<ClosedPosition, MarketError> {
        let trader = self.resolve_trader(SessionRegistryAction::Trade).await?;
        let mut state = self.state.borrow_mut();
        let mark_price = state.snapshot.mark_price;
        let cumulative_funding_rate_bps = state.snapshot.cumulative_funding_rate_bps;
        let (close, was_long, reduced_size, remove_position) = {
            let position = state.positions.get_mut(&trader).ok_or(MarketError::NoPosition)?;
            let original_abs = position.size.unsigned_abs();
            let was_long = position.size > 0;
            let close = MarketService::apply_close(
                position,
                size,
                mark_price,
                cumulative_funding_rate_bps,
            )?;
            (
                close,
                was_long,
                size.min(original_abs),
                position.size == 0,
            )
        };
        if was_long {
            state.snapshot.open_interest_long = state
                .snapshot
                .open_interest_long
                .saturating_sub(reduced_size);
        } else {
            state.snapshot.open_interest_short = state
                .snapshot
                .open_interest_short
                .saturating_sub(reduced_size);
        }
        if remove_position {
            state.positions.remove(&trader);
        }

        self.emit_event(MarketEvent::PositionClosed {
            trader,
            close: close.clone(),
        })
        .expect("event emission should succeed");
        Ok(close)
    }

    #[export(unwrap_result)]
    pub fn settle_funding(&mut self) -> Result<MarketSnapshot, MarketError> {
        let mut state = self.state.borrow_mut();
        MarketService::require_internal_or_owner(&state)?;
        let new_rate = MarketService::funding_rate(
            state.snapshot.mark_price,
            state.snapshot.index_price,
            state.config.risk.max_funding_velocity_bps,
        )?;
        state.snapshot.funding_rate_bps = new_rate;
        state.snapshot.cumulative_funding_rate_bps += new_rate;
        state.last_funding_block = MarketService::current_block();
        let interval = state.config.risk.funding_interval_blocks;
        MarketService::schedule_payload(MarketService::funding_payload(), interval);
        self.emit_event(MarketEvent::FundingSettled {
            funding_rate_bps: state.snapshot.funding_rate_bps,
            cumulative_funding_rate_bps: state.snapshot.cumulative_funding_rate_bps,
            block: state.last_funding_block,
        })
        .expect("event emission should succeed");
        Ok(state.snapshot)
    }

    #[export(unwrap_result)]
    pub fn check_liquidation(&mut self, trader: ActorId) -> Result<bool, MarketError> {
        let mut state = self.state.borrow_mut();
        MarketService::require_internal_or_owner(&state)?;
        let Some(position) = state.positions.get(&trader).cloned() else {
            return Ok(false);
        };

        let equity = MarketService::equity(
            &position,
            state.snapshot.mark_price,
            state.snapshot.cumulative_funding_rate_bps,
        )?;
        let maintenance = MarketService::maintenance_margin(
            &position,
            state.snapshot.mark_price,
            state.config.risk.maintenance_margin_bps,
        )?;
        if equity <= maintenance as i128 {
            if position.size > 0 {
                state.snapshot.open_interest_long = state
                    .snapshot
                    .open_interest_long
                    .saturating_sub(position.size.unsigned_abs());
            } else {
                state.snapshot.open_interest_short = state
                    .snapshot
                    .open_interest_short
                    .saturating_sub(position.size.unsigned_abs());
            }
            state.positions.remove(&trader);
            self.emit_event(MarketEvent::Liquidated {
                trader,
                mark_price: state.snapshot.mark_price,
                equity,
                maintenance_margin: maintenance,
            })
            .expect("event emission should succeed");
            return Ok(true);
        }

        MarketService::schedule_payload(
            MarketService::liquidation_payload(trader),
            state.config.risk.liquidation_delay_blocks,
        );
        Ok(false)
    }

    #[export]
    pub fn market_state(&self) -> MarketSnapshot {
        self.state.borrow().snapshot
    }

    #[export]
    pub fn config(&self) -> MarketConfig {
        self.state.borrow().config.clone()
    }

    #[export]
    pub fn position(&self, trader: ActorId) -> Option<Position> {
        self.state.borrow().positions.get(&trader).cloned()
    }
}

pub struct Program {
    state: RefCell<PerpMarketState>,
}

#[sails_rs::program]
impl Program {
    pub fn create(config: MarketConfig, initial_mark_price: u128, initial_index_price: u128) -> Self {
        let state = PerpMarketState {
            config,
            snapshot: MarketSnapshot {
                mark_price: initial_mark_price,
                index_price: initial_index_price,
                funding_rate_bps: 0,
                cumulative_funding_rate_bps: 0,
                open_interest_long: 0,
                open_interest_short: 0,
            },
            last_funding_block: exec::block_height(),
            positions: BTreeMap::new(),
        };
        let delay = state.config.risk.funding_interval_blocks;
        MarketService::schedule_payload(MarketService::funding_payload(), delay);
        Self {
            state: RefCell::new(state),
        }
    }

    pub fn market(&self) -> MarketService<'_> {
        MarketService::new(&self.state)
    }
}
