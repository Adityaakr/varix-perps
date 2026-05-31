#![no_std]

extern crate alloc;

use alloc::vec::Vec;
#[cfg(feature = "ethexe")]
use alloy_sol_types::{SolType, SolValue, private::SolTypeValue};
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
#[cfg(feature = "sessions")]
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
pub struct OpenPosition {
    pub id: u64,
    pub trader: ActorId,
    pub position: Position,
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
    PositionIdOverflow,
    PositionNotOwned,
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
    pub oracle_service: ActorId,
    pub margin_vault: ActorId,
    pub liquidity_pool: ActorId,
    pub session_registry: ActorId,
    pub risk: MarketRiskConfig,
}

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct PositionLookup {
    pub found: bool,
    pub position: OpenPosition,
}

pub struct PerpMarketState {
    config: MarketConfig,
    snapshot: MarketSnapshot,
    last_funding_block: u32,
    next_position_id: u64,
    positions: BTreeMap<u64, OpenPosition>,
    trader_positions: BTreeMap<ActorId, Vec<u64>>,
}

pub struct MarketService<'a> {
    state: &'a RefCell<PerpMarketState>,
}

enum TraderAction {
    AddMargin,
    Trade,
}

fn zero_actor_id() -> ActorId {
    ActorId::from([0u8; 32])
}

fn optional_actor_id(actor: ActorId) -> Option<ActorId> {
    if actor == zero_actor_id() {
        None
    } else {
        Some(actor)
    }
}

impl MarketConfig {
    fn oracle_service(&self) -> Option<ActorId> {
        optional_actor_id(self.oracle_service)
    }

    fn margin_vault(&self) -> Option<ActorId> {
        optional_actor_id(self.margin_vault)
    }

    fn liquidity_pool(&self) -> Option<ActorId> {
        optional_actor_id(self.liquidity_pool)
    }

    fn session_registry(&self) -> Option<ActorId> {
        optional_actor_id(self.session_registry)
    }
}

fn encode_asset(asset: Asset) -> u8 {
    match asset {
        Asset::Btc => 0,
        Asset::Eth => 1,
        Asset::Sol => 2,
    }
}

fn decode_asset(value: u8) -> Asset {
    match value {
        0 => Asset::Btc,
        1 => Asset::Eth,
        2 => Asset::Sol,
        _ => Asset::Btc,
    }
}

impl<'a> MarketService<'a> {
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
        if msg::source() == state.config.owner {
            Ok(())
        } else {
            Err(MarketError::Unauthorized)
        }
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

    fn next_position_id(state: &mut PerpMarketState) -> Result<u64, MarketError> {
        let id = state.next_position_id;
        state.next_position_id = state
            .next_position_id
            .checked_add(1)
            .ok_or(MarketError::PositionIdOverflow)?;
        Ok(id)
    }

    fn insert_position(
        state: &mut PerpMarketState,
        trader: ActorId,
        position: Position,
    ) -> Result<OpenPosition, MarketError> {
        let position_id = Self::next_position_id(state)?;
        let open_position = OpenPosition {
            id: position_id,
            trader,
            position,
        };
        state.positions.insert(position_id, open_position.clone());
        state
            .trader_positions
            .entry(trader)
            .or_default()
            .push(position_id);
        Ok(open_position)
    }

    fn trader_position_ids(state: &PerpMarketState, trader: ActorId) -> Vec<u64> {
        state
            .trader_positions
            .get(&trader)
            .cloned()
            .unwrap_or_default()
    }

    fn trader_net_position(state: &PerpMarketState, trader: ActorId) -> Option<OpenPosition> {
        Self::trader_position_ids(state, trader)
            .into_iter()
            .find_map(|position_id| state.positions.get(&position_id).cloned())
    }

    fn weighted_entry_price(
        existing: &Position,
        added_size: u128,
        fill_price: u128,
    ) -> Result<u128, MarketError> {
        let existing_size = existing.size.unsigned_abs();
        let total_size = existing_size
            .checked_add(added_size)
            .ok_or(MarketError::InvalidSize)?;
        let existing_value = existing_size
            .checked_mul(existing.entry_price)
            .ok_or(MarketError::InvalidPrice)?;
        let added_value = added_size
            .checked_mul(fill_price)
            .ok_or(MarketError::InvalidPrice)?;
        existing_value
            .checked_add(added_value)
            .ok_or(MarketError::InvalidPrice)?
            .checked_div(total_size)
            .ok_or(MarketError::InvalidPrice)
    }

    fn weighted_funding_rate(
        existing: &Position,
        added_size: u128,
        current_rate: i128,
    ) -> Result<i128, MarketError> {
        let existing_size = existing.size.unsigned_abs();
        let total_size = existing_size
            .checked_add(added_size)
            .ok_or(MarketError::InvalidSize)? as i128;
        let existing_weighted = existing
            .last_funding_rate_bps
            .checked_mul(existing_size as i128)
            .ok_or(MarketError::InvalidMargin)?;
        let added_weighted = current_rate
            .checked_mul(added_size as i128)
            .ok_or(MarketError::InvalidMargin)?;
        existing_weighted
            .checked_add(added_weighted)
            .ok_or(MarketError::InvalidMargin)?
            .checked_div(total_size)
            .ok_or(MarketError::InvalidMargin)
    }

    fn effective_leverage(
        size: u128,
        margin: u128,
        mark_price: u128,
        _fallback: u16,
    ) -> Result<u16, MarketError> {
        if margin == 0 {
            return Err(MarketError::InvalidMargin);
        }
        let notional = notional_to_collateral(size, mark_price).ok_or(MarketError::InvalidSize)?;
        let leverage = notional.checked_div(margin).unwrap_or(0).max(1);
        Ok(leverage.min(u16::MAX as u128) as u16)
    }

    fn remove_position(state: &mut PerpMarketState, position_id: u64) -> Option<OpenPosition> {
        let removed = state.positions.remove(&position_id)?;
        let should_remove_index = if let Some(ids) = state.trader_positions.get_mut(&removed.trader)
        {
            if let Some(index) = ids.iter().position(|id| *id == position_id) {
                ids.remove(index);
            }
            ids.is_empty()
        } else {
            false
        };
        if should_remove_index {
            state.trader_positions.remove(&removed.trader);
        }
        Some(removed)
    }

    fn trader_position(
        state: &PerpMarketState,
        trader: ActorId,
        position_id: u64,
    ) -> Result<OpenPosition, MarketError> {
        let position = state
            .positions
            .get(&position_id)
            .cloned()
            .ok_or(MarketError::NoPosition)?;
        if position.trader != trader {
            return Err(MarketError::PositionNotOwned);
        }
        Ok(position)
    }

    #[cfg(feature = "sessions")]
    async fn resolve_trader(&self, action: TraderAction) -> Result<ActorId, MarketError> {
        let caller = msg::source();
        let session_registry = self.state.borrow().config.session_registry();
        let Some(session_registry) = session_registry else {
            return Ok(caller);
        };

        let action = match action {
            TraderAction::AddMargin => SessionRegistryAction::AddMargin,
            TraderAction::Trade => SessionRegistryAction::Trade,
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

    #[cfg(not(feature = "sessions"))]
    async fn resolve_trader(&self, _action: TraderAction) -> Result<ActorId, MarketError> {
        Ok(msg::source())
    }

    async fn lock_in_vault(
        vault_id: ActorId,
        trader: ActorId,
        amount: u128,
    ) -> Result<(), MarketError> {
        if amount == 0 {
            return Ok(());
        }
        let vault = MarginVaultClientProgram::client(vault_id);
        let mut vault = vault.vault();
        vault.lock_margin(trader, amount)
            .await
            .map_err(|_| MarketError::ExternalIntegrationFailed)?;
        Ok(())
    }

    async fn reserve_in_pool(pool_id: ActorId, amount: u128) -> Result<(), MarketError> {
        if amount == 0 {
            return Ok(());
        }
        let pool = LiquidityPoolClientProgram::client(pool_id);
        let mut pool = pool.pool();
        pool.reserve_notional(amount)
            .await
            .map_err(|_| MarketError::ExternalIntegrationFailed)?;
        Ok(())
    }

    async fn release_in_pool(pool_id: ActorId, amount: u128) -> Result<(), MarketError> {
        if amount == 0 {
            return Ok(());
        }
        let pool = LiquidityPoolClientProgram::client(pool_id);
        let mut pool = pool.pool();
        pool.release_notional(amount)
            .await
            .map_err(|_| MarketError::ExternalIntegrationFailed)?;
        Ok(())
    }

    async fn ensure_pool_capacity_after_release(
        pool_id: ActorId,
        released_notional: u128,
        required_notional: u128,
    ) -> Result<(), MarketError> {
        if required_notional == 0 {
            return Ok(());
        }
        let pool = LiquidityPoolClientProgram::client(pool_id);
        let pool = pool.pool();
        let state = pool
            .pool_state()
            .await
            .map_err(|_| MarketError::ExternalIntegrationFailed)?;
        let reserved_after_close = state.reserved_notional.saturating_sub(released_notional);
        let available_after_close = state.max_capacity.saturating_sub(reserved_after_close);
        if available_after_close < required_notional {
            return Err(MarketError::SizeTooLarge);
        }
        Ok(())
    }

    async fn ensure_vault_margin_after_settlement(
        vault_id: ActorId,
        trader: ActorId,
        close_payout: u128,
        required_margin: u128,
    ) -> Result<(), MarketError> {
        if required_margin == 0 {
            return Ok(());
        }
        let vault = MarginVaultClientProgram::client(vault_id);
        let vault = vault.vault();
        let account = vault
            .account(trader)
            .await
            .map_err(|_| MarketError::ExternalIntegrationFailed)?;
        if account.free.saturating_add(close_payout) < required_margin {
            return Err(MarketError::InvalidMargin);
        }
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
        pool: ActorId,
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
        pool: ActorId,
    ) -> Result<(), MarketError> {
        let vault = MarginVaultClientProgram::client(vault_id);
        let mut vault = vault.vault();
        vault.slash_for_liquidation(trader, amount, pool)
            .await
            .map_err(|_| MarketError::ExternalIntegrationFailed)?;
        Ok(())
    }
}

#[sails_rs::service]
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
        Ok(state.snapshot)
    }

    #[export(unwrap_result)]
    pub async fn open_position(
        &mut self,
        side: Side,
        size: u128,
        leverage: u16,
        margin: u128,
        _max_slippage_bps: u16,
    ) -> Result<OpenPosition, MarketError> {
        let trader = self.resolve_trader(TraderAction::Trade).await?;
        let (mark_price, cumulative_funding_rate_bps, liquidity_pool, margin_vault) = {
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
            (
                state.snapshot.mark_price,
                state.snapshot.cumulative_funding_rate_bps,
                state.config.liquidity_pool(),
                state.config.margin_vault(),
            )
        };

        let notional = notional_to_collateral(size, mark_price).ok_or(MarketError::InvalidSize)?;
        let required_margin =
            collateral_for_leverage(notional, leverage).ok_or(MarketError::InvalidLeverage)?;

        let signed_size = side
            .direction()
            .checked_mul(size as i128)
            .ok_or(MarketError::InvalidSize)?;

        let existing = {
            let state = self.state.borrow();
            MarketService::trader_net_position(&state, trader)
        };

        let Some(existing) = existing else {
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

            let position = Position {
                size: signed_size,
                entry_price: mark_price,
                margin,
                leverage,
                last_funding_rate_bps: cumulative_funding_rate_bps,
                opened_at: MarketService::current_block() as u64,
            };

            let open_position = {
                let mut state = self.state.borrow_mut();
                if side == Side::Long {
                    state.snapshot.open_interest_long =
                        state.snapshot.open_interest_long.saturating_add(size);
                } else {
                    state.snapshot.open_interest_short =
                        state.snapshot.open_interest_short.saturating_add(size);
                }
                MarketService::insert_position(&mut state, trader, position)?
            };

            return Ok(open_position);
        };

        if existing.position.size.signum() == signed_size.signum() {
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

            let updated_position = {
                let mut state = self.state.borrow_mut();
                let total_abs_size = existing
                    .position
                    .size
                    .unsigned_abs()
                    .checked_add(size)
                    .ok_or(MarketError::InvalidSize)?;
                let total_margin = existing
                    .position
                    .margin
                    .checked_add(margin)
                    .ok_or(MarketError::InvalidMargin)?;
                let position = Position {
                    size: existing
                        .position
                        .size
                        .checked_add(signed_size)
                        .ok_or(MarketError::InvalidSize)?,
                    entry_price: MarketService::weighted_entry_price(
                        &existing.position,
                        size,
                        mark_price,
                    )?,
                    margin: total_margin,
                    leverage: MarketService::effective_leverage(
                        total_abs_size,
                        total_margin,
                        mark_price,
                        leverage,
                    )?,
                    last_funding_rate_bps: MarketService::weighted_funding_rate(
                        &existing.position,
                        size,
                        cumulative_funding_rate_bps,
                    )?,
                    opened_at: existing.position.opened_at,
                };
                let open_position = OpenPosition {
                    id: existing.id,
                    trader,
                    position,
                };
                if side == Side::Long {
                    state.snapshot.open_interest_long =
                        state.snapshot.open_interest_long.saturating_add(size);
                } else {
                    state.snapshot.open_interest_short =
                        state.snapshot.open_interest_short.saturating_add(size);
                }
                state.positions.insert(existing.id, open_position.clone());
                open_position
            };

            return Ok(updated_position);
        }

        let existing_abs_size = existing.position.size.unsigned_abs();
        let close_size = size.min(existing_abs_size);
        let leftover_size = size.saturating_sub(existing_abs_size);
        let released_notional =
            notional_to_collateral(close_size, mark_price).ok_or(MarketError::InvalidSize)?;
        let (preview, close) = MarketService::preview_close(
            &existing.position,
            close_size,
            mark_price,
            cumulative_funding_rate_bps,
        )?;
        let leftover_notional = if leftover_size > 0 {
            notional_to_collateral(leftover_size, mark_price).ok_or(MarketError::InvalidSize)?
        } else {
            0
        };
        let leftover_margin = if leftover_size > 0 {
            collateral_for_leverage(leftover_notional, leverage)
                .ok_or(MarketError::InvalidLeverage)?
        } else {
            0
        };

        if let Some(pool_id) = liquidity_pool {
            MarketService::ensure_pool_capacity_after_release(
                pool_id,
                released_notional,
                leftover_notional,
            )
            .await?;
        }
        if let Some(vault_id) = margin_vault {
            MarketService::ensure_vault_margin_after_settlement(
                vault_id,
                trader,
                close.payout,
                leftover_margin,
            )
            .await?;
        }

        if let Some(pool_id) = liquidity_pool {
            MarketService::release_in_pool(pool_id, released_notional).await?;
        }
        if close.payout > close.released_margin {
            let pool_id = liquidity_pool.ok_or(MarketError::MissingLiquidityPool)?;
            let vault_id = margin_vault.ok_or(MarketError::MissingMarginVault)?;
            MarketService::pay_profit_to_vault(
                pool_id,
                vault_id,
                close.payout.saturating_sub(close.released_margin),
            )
            .await?;
        }
        if let Some(vault_id) = margin_vault {
            MarketService::settle_in_vault(
                vault_id,
                trader,
                close.released_margin,
                close.payout,
                liquidity_pool.unwrap_or_else(zero_actor_id),
            )
            .await?;
        }

        if leftover_size > 0 {
            if let Some(pool_id) = liquidity_pool {
                MarketService::reserve_in_pool(pool_id, leftover_notional).await?;
            }
            if let Some(vault_id) = margin_vault {
                if let Err(error) =
                    MarketService::lock_in_vault(vault_id, trader, leftover_margin).await
                {
                    if let Some(pool_id) = liquidity_pool {
                        let _ = MarketService::release_in_pool(pool_id, leftover_notional).await;
                    }
                    return Err(error);
                }
            }
        }

        let mut state = self.state.borrow_mut();
        if existing.position.size > 0 {
            state.snapshot.open_interest_long =
                state.snapshot.open_interest_long.saturating_sub(close_size);
        } else {
            state.snapshot.open_interest_short =
                state.snapshot.open_interest_short.saturating_sub(close_size);
        }

        if leftover_size == 0 {
            if preview.size == 0 {
                let _ = MarketService::remove_position(&mut state, existing.id);
            } else {
                state.positions.insert(
                    existing.id,
                    OpenPosition {
                        id: existing.id,
                        trader,
                        position: preview.clone(),
                    },
                );
            }
            return Ok(OpenPosition {
                id: existing.id,
                trader,
                position: preview,
            });
        }

        let flipped_position = Position {
            size: signed_size.signum() * leftover_size as i128,
            entry_price: mark_price,
            margin: leftover_margin,
            leverage,
            last_funding_rate_bps: cumulative_funding_rate_bps,
            opened_at: MarketService::current_block() as u64,
        };
        let open_position = OpenPosition {
            id: existing.id,
            trader,
            position: flipped_position,
        };
        if side == Side::Long {
            state.snapshot.open_interest_long =
                state.snapshot.open_interest_long.saturating_add(leftover_size);
        } else {
            state.snapshot.open_interest_short =
                state.snapshot.open_interest_short.saturating_add(leftover_size);
        }
        state.positions.insert(existing.id, open_position.clone());

        Ok(open_position)
    }

    #[export(unwrap_result)]
    pub async fn add_margin(
        &mut self,
        position_id: u64,
        amount: u128,
    ) -> Result<OpenPosition, MarketError> {
        if amount == 0 {
            return Err(MarketError::InvalidMargin);
        }
        let trader = self.resolve_trader(TraderAction::AddMargin).await?;
        let margin_vault = {
            let state = self.state.borrow();
            let _ = MarketService::trader_position(&state, trader, position_id)?;
            state.config.margin_vault()
        };
        if let Some(vault_id) = margin_vault {
            MarketService::lock_in_vault(vault_id, trader, amount).await?;
        }

        let updated_position = {
            let mut state = self.state.borrow_mut();
            let position = state
                .positions
                .get_mut(&position_id)
                .ok_or(MarketError::NoPosition)?;
            if position.trader != trader {
                return Err(MarketError::PositionNotOwned);
            }
            position.position.margin = position.position.margin.saturating_add(amount);
            position.clone()
        };

        Ok(updated_position)
    }

    #[export(unwrap_result)]
    pub async fn close_position(
        &mut self,
        position_id: u64,
        size: u128,
    ) -> Result<ClosedPosition, MarketError> {
        let trader = self.resolve_trader(TraderAction::Trade).await?;
        let (position, mark_price, cumulative_funding_rate_bps, pool_id, vault_id) = {
            let state = self.state.borrow();
            let open_position = MarketService::trader_position(&state, trader, position_id)?;
            (
                open_position.position,
                state.snapshot.mark_price,
                state.snapshot.cumulative_funding_rate_bps,
                state.config.liquidity_pool(),
                state.config.margin_vault(),
            )
        };

        let was_long = position.size > 0;
        let reduced_size = size;
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
            MarketService::settle_in_vault(
                vault_id,
                trader,
                close.released_margin,
                close.payout,
                pool_id.unwrap_or_else(zero_actor_id),
            )
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
            let _ = MarketService::remove_position(&mut state, position_id);
        } else {
            state.positions.insert(
                position_id,
                OpenPosition {
                    id: position_id,
                    trader,
                    position: preview,
                },
            );
        }

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
        Ok(state.snapshot)
    }

    #[export(unwrap_result)]
    pub async fn check_liquidation(&mut self, trader: ActorId) -> Result<bool, MarketError> {
        let position_ids = {
            let state = self.state.borrow();
            MarketService::require_internal_or_owner(&state)?;
            MarketService::trader_position_ids(&state, trader)
        };
        if position_ids.is_empty() {
            return Ok(false);
        }

        let mut liquidated_any = false;

        for position_id in position_ids {
            let (open_position, mark_price, cumulative_funding_rate_bps, maintenance_bps, pool_id, vault_id) = {
                let state = self.state.borrow();
                let Some(open_position) = state.positions.get(&position_id).cloned() else {
                    continue;
                };
                (
                    open_position,
                    state.snapshot.mark_price,
                    state.snapshot.cumulative_funding_rate_bps,
                    state.config.risk.maintenance_margin_bps,
                    state.config.liquidity_pool(),
                    state.config.margin_vault(),
                )
            };

            let equity = MarketService::equity(
                &open_position.position,
                mark_price,
                cumulative_funding_rate_bps,
            )?;
            let maintenance = MarketService::maintenance_margin(
                &open_position.position,
                mark_price,
                maintenance_bps,
            )?;
            if equity <= maintenance as i128 {
                let released_notional =
                    notional_to_collateral(open_position.position.size.unsigned_abs(), mark_price)
                        .ok_or(MarketError::InvalidSize)?;
                if let Some(pool_id) = pool_id {
                    MarketService::release_in_pool(pool_id, released_notional).await?;
                }
                if let Some(vault_id) = vault_id {
                    MarketService::slash_in_vault(
                        vault_id,
                        open_position.trader,
                        open_position.position.margin,
                        pool_id.unwrap_or_else(zero_actor_id),
                    )
                    .await?;
                }

                let mut state = self.state.borrow_mut();
                if open_position.position.size > 0 {
                    state.snapshot.open_interest_long = state
                        .snapshot
                        .open_interest_long
                        .saturating_sub(open_position.position.size.unsigned_abs());
                } else {
                    state.snapshot.open_interest_short = state
                        .snapshot
                        .open_interest_short
                        .saturating_sub(open_position.position.size.unsigned_abs());
                }
                let _ = MarketService::remove_position(&mut state, position_id);
                liquidated_any = true;
            }
        }

        Ok(liquidated_any)
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
    pub fn position(&self, position_id: u64) -> PositionLookup {
        let position = self.state.borrow().positions.get(&position_id).cloned();
        PositionLookup {
            found: position.is_some(),
            position: position.unwrap_or(OpenPosition {
                id: 0,
                trader: zero_actor_id(),
                position: Position {
                    size: 0,
                    entry_price: 0,
                    margin: 0,
                    leverage: 0,
                    last_funding_rate_bps: 0,
                    opened_at: 0,
                },
            }),
        }
    }

    #[export]
    pub fn positions(&self, trader: ActorId) -> Vec<OpenPosition> {
        let state = self.state.borrow();
        MarketService::trader_position_ids(&state, trader)
            .into_iter()
            .filter_map(|position_id| state.positions.get(&position_id).cloned())
            .collect()
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
            next_position_id: 1,
            positions: BTreeMap::new(),
            trader_positions: BTreeMap::new(),
        };
        Self {
            state: RefCell::new(state),
        }
    }

    pub fn market(&self) -> MarketService<'_> {
        MarketService::new(&self.state)
    }
}

#[cfg(feature = "ethexe")]
alloy_sol_types::sol! {
    struct ClosedPositionSol {
        int128 realized_pnl;
        int128 funding_paid;
        uint128 released_margin;
        uint128 payout;
        uint128 remaining_margin;
    }

    struct OpenPositionSol {
        uint64 id;
        address trader;
        int128 size;
        uint128 entry_price;
        uint128 margin;
        uint16 leverage;
        int128 last_funding_rate_bps;
        uint64 opened_at;
    }

    struct PositionLookupSol {
        bool found;
        OpenPositionSol position;
    }

    struct MarketConfigSol {
        address owner;
        uint8 asset;
        address oracle_service;
        address margin_vault;
        address liquidity_pool;
        address session_registry;
        uint16 initial_margin_bps;
        uint16 maintenance_margin_bps;
        uint16 max_leverage;
        uint32 funding_interval_blocks;
        uint32 liquidation_delay_blocks;
        int16 max_funding_velocity_bps;
    }
}

#[cfg(feature = "ethexe")]
impl From<ClosedPositionSol> for ClosedPosition {
    fn from(value: ClosedPositionSol) -> Self {
        Self {
            realized_pnl: value.realized_pnl,
            funding_paid: value.funding_paid,
            released_margin: value.released_margin,
            payout: value.payout,
            remaining_margin: value.remaining_margin,
        }
    }
}

#[cfg(feature = "ethexe")]
impl From<ClosedPosition> for ClosedPositionSol {
    fn from(value: ClosedPosition) -> Self {
        Self {
            realized_pnl: value.realized_pnl,
            funding_paid: value.funding_paid,
            released_margin: value.released_margin,
            payout: value.payout,
            remaining_margin: value.remaining_margin,
        }
    }
}

#[cfg(feature = "ethexe")]
impl SolValue for ClosedPosition {
    type SolType = ClosedPositionSol;
}

#[cfg(feature = "ethexe")]
impl SolTypeValue<ClosedPositionSol> for ClosedPosition {
    fn stv_to_tokens(&self) -> <ClosedPositionSol as SolType>::Token<'_> {
        let value: ClosedPositionSol = self.clone().into();
        <ClosedPositionSol as SolTypeValue<ClosedPositionSol>>::stv_to_tokens(&value)
    }

    fn stv_abi_encode_packed_to(&self, out: &mut sails_rs::Vec<u8>) {
        let value: ClosedPositionSol = self.clone().into();
        <ClosedPositionSol as SolTypeValue<ClosedPositionSol>>::stv_abi_encode_packed_to(
            &value, out,
        );
    }

    fn stv_eip712_data_word(&self) -> sails_rs::alloy_sol_types::Word {
        let value: ClosedPositionSol = self.clone().into();
        <ClosedPositionSol as SolTypeValue<ClosedPositionSol>>::stv_eip712_data_word(&value)
    }
}

#[cfg(feature = "ethexe")]
impl From<OpenPositionSol> for OpenPosition {
    fn from(value: OpenPositionSol) -> Self {
        Self {
            id: value.id,
            trader: value.trader.into(),
            position: Position {
                size: value.size,
                entry_price: value.entry_price,
                margin: value.margin,
                leverage: value.leverage,
                last_funding_rate_bps: value.last_funding_rate_bps,
                opened_at: value.opened_at,
            },
        }
    }
}

#[cfg(feature = "ethexe")]
impl From<OpenPosition> for OpenPositionSol {
    fn from(value: OpenPosition) -> Self {
        Self {
            id: value.id,
            trader: value.trader.into(),
            size: value.position.size,
            entry_price: value.position.entry_price,
            margin: value.position.margin,
            leverage: value.position.leverage,
            last_funding_rate_bps: value.position.last_funding_rate_bps,
            opened_at: value.position.opened_at,
        }
    }
}

#[cfg(feature = "ethexe")]
impl SolValue for OpenPosition {
    type SolType = OpenPositionSol;
}

#[cfg(feature = "ethexe")]
impl SolTypeValue<OpenPositionSol> for OpenPosition {
    fn stv_to_tokens(&self) -> <OpenPositionSol as SolType>::Token<'_> {
        let value: OpenPositionSol = self.clone().into();
        <OpenPositionSol as SolTypeValue<OpenPositionSol>>::stv_to_tokens(&value)
    }

    fn stv_abi_encode_packed_to(&self, out: &mut sails_rs::Vec<u8>) {
        let value: OpenPositionSol = self.clone().into();
        <OpenPositionSol as SolTypeValue<OpenPositionSol>>::stv_abi_encode_packed_to(&value, out);
    }

    fn stv_eip712_data_word(&self) -> sails_rs::alloy_sol_types::Word {
        let value: OpenPositionSol = self.clone().into();
        <OpenPositionSol as SolTypeValue<OpenPositionSol>>::stv_eip712_data_word(&value)
    }
}

#[cfg(feature = "ethexe")]
impl From<PositionLookupSol> for PositionLookup {
    fn from(value: PositionLookupSol) -> Self {
        Self {
            found: value.found,
            position: value.position.into(),
        }
    }
}

#[cfg(feature = "ethexe")]
impl From<PositionLookup> for PositionLookupSol {
    fn from(value: PositionLookup) -> Self {
        Self {
            found: value.found,
            position: value.position.into(),
        }
    }
}

#[cfg(feature = "ethexe")]
impl SolValue for PositionLookup {
    type SolType = PositionLookupSol;
}

#[cfg(feature = "ethexe")]
impl SolTypeValue<PositionLookupSol> for PositionLookup {
    fn stv_to_tokens(&self) -> <PositionLookupSol as SolType>::Token<'_> {
        let value: PositionLookupSol = self.clone().into();
        <PositionLookupSol as SolTypeValue<PositionLookupSol>>::stv_to_tokens(&value)
    }

    fn stv_abi_encode_packed_to(&self, out: &mut sails_rs::Vec<u8>) {
        let value: PositionLookupSol = self.clone().into();
        <PositionLookupSol as SolTypeValue<PositionLookupSol>>::stv_abi_encode_packed_to(
            &value, out,
        );
    }

    fn stv_eip712_data_word(&self) -> sails_rs::alloy_sol_types::Word {
        let value: PositionLookupSol = self.clone().into();
        <PositionLookupSol as SolTypeValue<PositionLookupSol>>::stv_eip712_data_word(&value)
    }
}

#[cfg(feature = "ethexe")]
impl From<MarketConfigSol> for MarketConfig {
    fn from(value: MarketConfigSol) -> Self {
        Self {
            owner: value.owner.into(),
            asset: decode_asset(value.asset),
            oracle_service: value.oracle_service.into(),
            margin_vault: value.margin_vault.into(),
            liquidity_pool: value.liquidity_pool.into(),
            session_registry: value.session_registry.into(),
            risk: MarketRiskConfig {
                initial_margin_bps: value.initial_margin_bps,
                maintenance_margin_bps: value.maintenance_margin_bps,
                max_leverage: value.max_leverage,
                funding_interval_blocks: value.funding_interval_blocks,
                liquidation_delay_blocks: value.liquidation_delay_blocks,
                max_funding_velocity_bps: value.max_funding_velocity_bps,
            },
        }
    }
}

#[cfg(feature = "ethexe")]
impl From<MarketConfig> for MarketConfigSol {
    fn from(value: MarketConfig) -> Self {
        Self {
            owner: value.owner.into(),
            asset: encode_asset(value.asset),
            oracle_service: value.oracle_service.into(),
            margin_vault: value.margin_vault.into(),
            liquidity_pool: value.liquidity_pool.into(),
            session_registry: value.session_registry.into(),
            initial_margin_bps: value.risk.initial_margin_bps,
            maintenance_margin_bps: value.risk.maintenance_margin_bps,
            max_leverage: value.risk.max_leverage,
            funding_interval_blocks: value.risk.funding_interval_blocks,
            liquidation_delay_blocks: value.risk.liquidation_delay_blocks,
            max_funding_velocity_bps: value.risk.max_funding_velocity_bps,
        }
    }
}

#[cfg(feature = "ethexe")]
impl SolValue for MarketConfig {
    type SolType = MarketConfigSol;
}

#[cfg(feature = "ethexe")]
impl SolTypeValue<MarketConfigSol> for MarketConfig {
    fn stv_to_tokens(&self) -> <MarketConfigSol as SolType>::Token<'_> {
        let value: MarketConfigSol = self.clone().into();
        <MarketConfigSol as SolTypeValue<MarketConfigSol>>::stv_to_tokens(&value)
    }

    fn stv_abi_encode_packed_to(&self, out: &mut sails_rs::Vec<u8>) {
        let value: MarketConfigSol = self.clone().into();
        <MarketConfigSol as SolTypeValue<MarketConfigSol>>::stv_abi_encode_packed_to(&value, out);
    }

    fn stv_eip712_data_word(&self) -> sails_rs::alloy_sol_types::Word {
        let value: MarketConfigSol = self.clone().into();
        <MarketConfigSol as SolTypeValue<MarketConfigSol>>::stv_eip712_data_word(&value)
    }
}
