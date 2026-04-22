#![no_std]

extern crate alloc;

use liquidity_pool_client::{
    pool::Pool as PoolCalls,
    LiquidityPoolClient,
    LiquidityPoolClientProgram,
};
use margin_vault_client::{
    vault::Vault as VaultCalls,
    MarginVaultClient,
    MarginVaultClientProgram,
};
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
    pub released_margin: u128,
    pub payout: u128,
    pub remaining_margin: u128,
}

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum MarketError {
    ExternalIntegrationFailed,
    InternalOnly,
    InvalidLeverage,
    InvalidMargin,
    InvalidPrice,
    InvalidSize,
    MissingLiquidityPool,
    MissingMarginVault,
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
    pub liquidity_pool: Option<ActorId>,
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
        notional_to_collateral(position.size.unsigned_abs(), mark_price)
            .ok_or(MarketError::InvalidSize)
    }

    fn funding_delta(
        position: &Position,
        current_rate: i128,
        mark_price: u128,
    ) -> Result<i128, MarketError> {
        let notional = Self::notional(position, mark_price)? as i128;
        let delta_rate = current_rate - position.last_funding_rate_bps;
        let raw = notional
            .checked_mul(delta_rate)
            .ok_or(MarketError::InvalidMargin)?
            .checked_div(BPS_DIVISOR as i128)
            .ok_or(MarketError::InvalidMargin)?;

        Ok(if position.size > 0 { raw } else { -raw })
    }

    fn equity(
        position: &Position,
        mark_price: u128,
        current_rate: i128,
    ) -> Result<i128, MarketError> {
        let pnl = pnl_to_collateral(position.size, position.entry_price, mark_price)
            .ok_or(MarketError::InvalidPrice)?;
        let funding = Self::funding_delta(position, current_rate, mark_price)?;
        Ok(position.margin as i128 + pnl - funding)
    }

    fn maintenance_margin(
        position: &Position,
        mark_price: u128,
        bps: u16,
    ) -> Result<u128, MarketError> {
        let notional = Self::notional(position, mark_price)?;
        margin_requirement(notional, bps).ok_or(MarketError::InvalidMargin)
    }

    fn preview_close(
        position: &Position,
        close_size: u128,
        mark_price: u128,
        cumulative_funding_rate_bps: i128,
    ) -> Result<(Position, ClosedPosition), MarketError> {
        let mut preview = position.clone();
        let original_abs = preview.size.unsigned_abs();
        if close_size == 0 {
            return Err(MarketError::InvalidSize);
        }
        if close_size > original_abs {
            return Err(MarketError::SizeTooLarge);
        }

        let released_margin = preview
            .margin
            .checked_mul(close_size)
            .ok_or(MarketError::InvalidMargin)?
            .checked_div(original_abs)
            .ok_or(MarketError::InvalidMargin)?;
        let signed_close = if preview.size > 0 {
            close_size as i128
        } else {
            -(close_size as i128)
        };
        let realized_pnl = pnl_to_collateral(signed_close, preview.entry_price, mark_price)
            .ok_or(MarketError::InvalidPrice)?;
        let funding_paid = Self::funding_delta(&preview, cumulative_funding_rate_bps, mark_price)?
            .checked_mul(close_size as i128)
            .ok_or(MarketError::InvalidMargin)?
            .checked_div(original_abs as i128)
            .ok_or(MarketError::InvalidMargin)?;

        preview.margin = preview
            .margin
            .checked_sub(released_margin)
            .ok_or(MarketError::InvalidMargin)?;
        preview.size -= signed_close;
        preview.last_funding_rate_bps = cumulative_funding_rate_bps;

        let payout_i = released_margin as i128 + realized_pnl - funding_paid;
        let payout = payout_i.max(0) as u128;
        let close = ClosedPosition {
            realized_pnl,
            funding_paid,
            released_margin,
            payout,
            remaining_margin: preview.margin,
        };
        Ok((preview, close))
    }

    fn funding_rate(
        mark_price: u128,
        index_price: u128,
        max_velocity_bps: i16,
    ) -> Result<i128, MarketError> {
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

    async fn lock_in_vault(vault_id: ActorId, trader: ActorId, amount: u128) -> Result<(), MarketError> {
        let vault = MarginVaultClientProgram::client(vault_id);
        let mut vault = vault.vault();
        vault.lock_margin(trader, amount)
            .await
            .map_err(|_| MarketError::ExternalIntegrationFailed)?;
        Ok(())
    }

    async fn reserve_in_pool(pool_id: ActorId, amount: u128) -> Result<(), MarketError> {
        let pool = LiquidityPoolClientProgram::client(pool_id);
        let mut pool = pool.pool();
        pool.reserve_notional(amount)
            .await
            .map_err(|_| MarketError::ExternalIntegrationFailed)?;
        Ok(())
    }

    async fn release_in_pool(pool_id: ActorId, amount: u128) -> Result<(), MarketError> {
        let pool = LiquidityPoolClientProgram::client(pool_id);
        let mut pool = pool.pool();
        pool.release_notional(amount)
            .await
            .map_err(|_| MarketError::ExternalIntegrationFailed)?;
        Ok(())
    }

    async fn pay_profit_to_vault(
        pool_id: ActorId,
        vault_id: ActorId,
        amount: u128,
    ) -> Result<(), MarketError> {
        if amount == 0 {
            return Ok(());
        }
        let pool = LiquidityPoolClientProgram::client(pool_id);
        let mut pool = pool.pool();
        pool.pay_out_to_vault(vault_id, amount)
            .await
            .map_err(|_| MarketError::ExternalIntegrationFailed)?;
        Ok(())
    }

    async fn settle_in_vault(
        vault_id: ActorId,
        trader: ActorId,
        released_margin: u128,
        payout: u128,
        pool: Option<ActorId>,
    ) -> Result<(), MarketError> {
        let vault = MarginVaultClientProgram::client(vault_id);
        let mut vault = vault.vault();
        vault.settle_position(trader, released_margin, payout, pool)
            .await
            .map_err(|_| MarketError::ExternalIntegrationFailed)?;
        Ok(())
    }

    async fn slash_in_vault(
        vault_id: ActorId,
        trader: ActorId,
        amount: u128,
        pool: Option<ActorId>,
    ) -> Result<(), MarketError> {
        let vault = MarginVaultClientProgram::client(vault_id);
        let mut vault = vault.vault();
        vault.slash_for_liquidation(trader, amount, pool)
            .await
            .map_err(|_| MarketError::ExternalIntegrationFailed)?;
        Ok(())
    }
}

#[sails_rs::service(events = MarketEvent)]
impl MarketService<'_> {
    #[export(unwrap_result)]
    pub fn update_price(
        &mut self,
        mark_price: u128,
        index_price: u128,
    ) -> Result<MarketSnapshot, MarketError> {
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
        let (mark_price, cumulative_funding_rate_bps, liquidity_pool, margin_vault, delay) = {
            let state = self.state.borrow();
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
            (
                state.snapshot.mark_price,
                state.snapshot.cumulative_funding_rate_bps,
                state.config.liquidity_pool,
                state.config.margin_vault,
                state.config.risk.liquidation_delay_blocks,
            )
        };

        let notional = notional_to_collateral(size, mark_price).ok_or(MarketError::InvalidSize)?;
        let required_margin =
            collateral_for_leverage(notional, leverage).ok_or(MarketError::InvalidLeverage)?;
        if margin < required_margin {
            return Err(MarketError::InvalidMargin);
        }

        if let Some(pool_id) = liquidity_pool {
            MarketService::reserve_in_pool(pool_id, notional).await?;
        }
        if let Some(vault_id) = margin_vault {
            if let Err(error) = MarketService::lock_in_vault(vault_id, trader, margin).await {
                if let Some(pool_id) = liquidity_pool {
                    let _ = MarketService::release_in_pool(pool_id, notional).await;
                }
                return Err(error);
            }
        }

        let signed_size = side
            .direction()
            .checked_mul(size as i128)
            .ok_or(MarketError::InvalidSize)?;
        let position = Position {
            size: signed_size,
            entry_price: mark_price,
            margin,
            leverage,
            last_funding_rate_bps: cumulative_funding_rate_bps,
            opened_at: MarketService::current_block() as u64,
        };

        let mut state = self.state.borrow_mut();
        if side == Side::Long {
            state.snapshot.open_interest_long =
                state.snapshot.open_interest_long.saturating_add(size);
        } else {
            state.snapshot.open_interest_short =
                state.snapshot.open_interest_short.saturating_add(size);
        }
        state.positions.insert(trader, position.clone());
        MarketService::schedule_payload(MarketService::liquidation_payload(trader), delay);
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
        let margin_vault = self.state.borrow().config.margin_vault;
        if let Some(vault_id) = margin_vault {
            MarketService::lock_in_vault(vault_id, trader, amount).await?;
        }

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
        let (position, mark_price, cumulative_funding_rate_bps, pool_id, vault_id) = {
            let state = self.state.borrow();
            (
                state.positions.get(&trader).cloned().ok_or(MarketError::NoPosition)?,
                state.snapshot.mark_price,
                state.snapshot.cumulative_funding_rate_bps,
                state.config.liquidity_pool,
                state.config.margin_vault,
            )
        };

        let was_long = position.size > 0;
        let reduced_size = size.min(position.size.unsigned_abs());
        let released_notional =
            notional_to_collateral(reduced_size, mark_price).ok_or(MarketError::InvalidSize)?;
        let (preview, close) =
            MarketService::preview_close(&position, size, mark_price, cumulative_funding_rate_bps)?;

        if let Some(pool_id) = pool_id {
            MarketService::release_in_pool(pool_id, released_notional).await?;
        }
        if close.payout > close.released_margin {
            let pool_id = pool_id.ok_or(MarketError::MissingLiquidityPool)?;
            let vault_id = vault_id.ok_or(MarketError::MissingMarginVault)?;
            MarketService::pay_profit_to_vault(
                pool_id,
                vault_id,
                close.payout.saturating_sub(close.released_margin),
            )
            .await?;
        }
        if let Some(vault_id) = vault_id {
            MarketService::settle_in_vault(vault_id, trader, close.released_margin, close.payout, pool_id)
                .await?;
        }

        let mut state = self.state.borrow_mut();
        if was_long {
            state.snapshot.open_interest_long =
                state.snapshot.open_interest_long.saturating_sub(reduced_size);
        } else {
            state.snapshot.open_interest_short =
                state.snapshot.open_interest_short.saturating_sub(reduced_size);
        }
        if preview.size == 0 {
            state.positions.remove(&trader);
        } else {
            state.positions.insert(trader, preview);
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
    pub async fn check_liquidation(&mut self, trader: ActorId) -> Result<bool, MarketError> {
        let (position, mark_price, cumulative_funding_rate_bps, maintenance_bps, pool_id, vault_id) = {
            let state = self.state.borrow();
            MarketService::require_internal_or_owner(&state)?;
            let Some(position) = state.positions.get(&trader).cloned() else {
                return Ok(false);
            };
            (
                position,
                state.snapshot.mark_price,
                state.snapshot.cumulative_funding_rate_bps,
                state.config.risk.maintenance_margin_bps,
                state.config.liquidity_pool,
                state.config.margin_vault,
            )
        };

        let equity = MarketService::equity(&position, mark_price, cumulative_funding_rate_bps)?;
        let maintenance =
            MarketService::maintenance_margin(&position, mark_price, maintenance_bps)?;
        if equity <= maintenance as i128 {
            let released_notional =
                notional_to_collateral(position.size.unsigned_abs(), mark_price)
                    .ok_or(MarketError::InvalidSize)?;
            if let Some(pool_id) = pool_id {
                MarketService::release_in_pool(pool_id, released_notional).await?;
            }
            if let Some(vault_id) = vault_id {
                MarketService::slash_in_vault(vault_id, trader, position.margin, pool_id).await?;
            }

            let mut state = self.state.borrow_mut();
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

        let delay = self.state.borrow().config.risk.liquidation_delay_blocks;
        MarketService::schedule_payload(MarketService::liquidation_payload(trader), delay);
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
    pub fn create(
        config: MarketConfig,
        initial_mark_price: u128,
        initial_index_price: u128,
    ) -> Self {
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
