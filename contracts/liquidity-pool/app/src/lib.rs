#![no_std]

use demo_usdc_vft_client::{
    token::Token as TokenCalls,
    DemoUsdcVftClient,
    DemoUsdcVftClientProgram,
};
#[cfg(feature = "ethexe")]
use alloy_sol_types::{SolType, SolValue, private::SolTypeValue};
use sails_rs::{
    cell::RefCell,
    client::Program as _,
    collections::BTreeMap,
    gstd::{exec, msg},
    prelude::*,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct LpAccount {
    pub shares: u128,
    pub deposited: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct PoolState {
    pub total_liquidity: u128,
    pub total_shares: u128,
    pub reserved_notional: u128,
    pub max_capacity: u128,
}

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum PoolError {
    InsufficientAvailableLiquidity,
    InsufficientShares,
    MarketAlreadyAuthorized,
    MarketNotAuthorized,
    TokenTransferFailed,
    Unauthorized,
    ZeroAmount,
}

pub struct LiquidityPoolState {
    owner: ActorId,
    token_program: ActorId,
    capacity_multiplier_bps: u16,
    total_liquidity: u128,
    total_shares: u128,
    reserved_notional: u128,
    providers: BTreeMap<ActorId, LpAccount>,
    authorized_markets: BTreeMap<ActorId, bool>,
}

pub struct PoolService<'a> {
    state: &'a RefCell<LiquidityPoolState>,
}

impl<'a> PoolService<'a> {
    pub fn new(state: &'a RefCell<LiquidityPoolState>) -> Self {
        Self { state }
    }

    fn require_owner(state: &LiquidityPoolState) -> Result<(), PoolError> {
        if msg::source() == state.owner {
            Ok(())
        } else {
            Err(PoolError::Unauthorized)
        }
    }

    fn require_market(state: &LiquidityPoolState) -> Result<(), PoolError> {
        // Local dev-node bootstrap is simpler when the first market can interact
        // before explicit authorization is configured. Once any authorization
        // exists, only the approved market set is allowed.
        if state.authorized_markets.is_empty() {
            return Ok(());
        }
        if state
            .authorized_markets
            .get(&msg::source())
            .copied()
            .unwrap_or(false)
        {
            Ok(())
        } else {
            Err(PoolError::Unauthorized)
        }
    }

    fn require_positive(amount: u128) -> Result<(), PoolError> {
        if amount == 0 {
            Err(PoolError::ZeroAmount)
        } else {
            Ok(())
        }
    }

    fn max_capacity(state: &LiquidityPoolState) -> u128 {
        state
            .total_liquidity
            .saturating_mul(state.capacity_multiplier_bps as u128)
            / 10_000
    }
}

#[sails_rs::service]
impl PoolService<'_> {
    #[export(unwrap_result)]
    pub async fn deposit_liquidity(&mut self, amount: u128) -> Result<LpAccount, PoolError> {
        PoolService::require_positive(amount)?;
        let provider = msg::source();
        let token_program = self.state.borrow().token_program;
        let token = DemoUsdcVftClientProgram::client(token_program);
        let mut token = token.token();
        let transferred = token
            .transfer_from(provider, exec::program_id(), amount)
            .await
            .map_err(|_| PoolError::TokenTransferFailed)?;
        if !transferred {
            return Err(PoolError::TokenTransferFailed);
        }

        let mut state = self.state.borrow_mut();
        let shares = if state.total_liquidity == 0 || state.total_shares == 0 {
            amount
        } else {
            amount.saturating_mul(state.total_shares) / state.total_liquidity
        };
        state.total_liquidity = state.total_liquidity.saturating_add(amount);
        state.total_shares = state.total_shares.saturating_add(shares);
        let account = state.providers.entry(provider).or_insert(LpAccount {
            shares: 0,
            deposited: 0,
        });
        account.shares = account.shares.saturating_add(shares);
        account.deposited = account.deposited.saturating_add(amount);
        let snapshot = *account;
        Ok(snapshot)
    }

    #[export(unwrap_result)]
    pub async fn withdraw_liquidity(&mut self, shares: u128) -> Result<LpAccount, PoolError> {
        PoolService::require_positive(shares)?;
        let provider = msg::source();
        let (amount, token_program, snapshot) = {
            let mut state = self.state.borrow_mut();
            let available = state
                .total_liquidity
                .saturating_sub(state.reserved_notional.min(state.total_liquidity));
            let total_shares = state.total_shares.max(1);
            let amount = shares.saturating_mul(state.total_liquidity) / total_shares;
            if amount > available {
                return Err(PoolError::InsufficientAvailableLiquidity);
            }

            let previous = state
                .providers
                .get(&provider)
                .copied()
                .ok_or(PoolError::InsufficientShares)?;
            if previous.shares < shares {
                return Err(PoolError::InsufficientShares);
            }
            let updated = LpAccount {
                shares: previous.shares - shares,
                deposited: previous
                    .deposited
                    .saturating_sub(amount.min(previous.deposited)),
            };
            state.providers.insert(provider, updated);
            state.total_shares -= shares;
            state.total_liquidity -= amount;
            (amount, state.token_program, updated)
        };

        let token = DemoUsdcVftClientProgram::client(token_program);
        let mut token = token.token();
        let transferred = token
            .transfer(provider, amount)
            .await
            .map_err(|_| PoolError::TokenTransferFailed)?;
        if !transferred {
            return Err(PoolError::TokenTransferFailed);
        }

        Ok(snapshot)
    }

    #[export(unwrap_result)]
    pub fn authorize_market(&mut self, market: ActorId) -> Result<(), PoolError> {
        let mut state = self.state.borrow_mut();
        PoolService::require_owner(&state)?;
        if state.authorized_markets.insert(market, true).is_some() {
            return Err(PoolError::MarketAlreadyAuthorized);
        }
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn revoke_market(&mut self, market: ActorId) -> Result<(), PoolError> {
        let mut state = self.state.borrow_mut();
        PoolService::require_owner(&state)?;
        if state.authorized_markets.remove(&market).is_none() {
            return Err(PoolError::MarketNotAuthorized);
        }
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn reserve_notional(&mut self, amount: u128) -> Result<PoolState, PoolError> {
        PoolService::require_positive(amount)?;
        let mut state = self.state.borrow_mut();
        PoolService::require_market(&state)?;
        let next = state.reserved_notional.saturating_add(amount);
        let max_capacity = PoolService::max_capacity(&state);
        if next > max_capacity {
            return Err(PoolError::InsufficientAvailableLiquidity);
        }
        state.reserved_notional = next;
        let snapshot = PoolState {
            total_liquidity: state.total_liquidity,
            total_shares: state.total_shares,
            reserved_notional: state.reserved_notional,
            max_capacity,
        };
        Ok(snapshot)
    }

    #[export(unwrap_result)]
    pub fn release_notional(&mut self, amount: u128) -> Result<PoolState, PoolError> {
        PoolService::require_positive(amount)?;
        let mut state = self.state.borrow_mut();
        PoolService::require_market(&state)?;
        state.reserved_notional = state.reserved_notional.saturating_sub(amount);
        let snapshot = PoolState {
            total_liquidity: state.total_liquidity,
            total_shares: state.total_shares,
            reserved_notional: state.reserved_notional,
            max_capacity: PoolService::max_capacity(&state),
        };
        Ok(snapshot)
    }

    #[export(unwrap_result)]
    pub async fn pay_out_to_vault(
        &mut self,
        vault: ActorId,
        amount: u128,
    ) -> Result<PoolState, PoolError> {
        PoolService::require_positive(amount)?;
        let token_program = {
            let state = self.state.borrow();
            PoolService::require_market(&state)?;
            state.token_program
        };

        let token = DemoUsdcVftClientProgram::client(token_program);
        let mut token = token.token();
        let transferred = token
            .transfer(vault, amount)
            .await
            .map_err(|_| PoolError::TokenTransferFailed)?;
        if !transferred {
            return Err(PoolError::TokenTransferFailed);
        }

        let state = self.state.borrow();
        let snapshot = PoolState {
            total_liquidity: state.total_liquidity,
            total_shares: state.total_shares,
            reserved_notional: state.reserved_notional,
            max_capacity: PoolService::max_capacity(&state),
        };
        Ok(snapshot)
    }

    #[export]
    pub fn account(&self, provider: ActorId) -> LpAccount {
        self.state
            .borrow()
            .providers
            .get(&provider)
            .copied()
            .unwrap_or(LpAccount {
                shares: 0,
                deposited: 0,
            })
    }

    #[export]
    pub fn pool_state(&self) -> PoolState {
        let state = self.state.borrow();
        PoolState {
            total_liquidity: state.total_liquidity,
            total_shares: state.total_shares,
            reserved_notional: state.reserved_notional,
            max_capacity: PoolService::max_capacity(&state),
        }
    }
}

pub struct Program {
    state: RefCell<LiquidityPoolState>,
}

#[sails_rs::program]
impl Program {
    pub fn create(owner: ActorId, token_program: ActorId, capacity_multiplier_bps: u16) -> Self {
        Self {
            state: RefCell::new(LiquidityPoolState {
                owner,
                token_program,
                capacity_multiplier_bps,
                total_liquidity: 0,
                total_shares: 0,
                reserved_notional: 0,
                providers: BTreeMap::new(),
                authorized_markets: BTreeMap::new(),
            }),
        }
    }

    pub fn pool(&self) -> PoolService<'_> {
        PoolService::new(&self.state)
    }
}

#[cfg(feature = "ethexe")]
alloy_sol_types::sol! {
    struct LpAccountSol {
        uint128 shares;
        uint128 deposited;
    }

    struct PoolStateSol {
        uint128 total_liquidity;
        uint128 total_shares;
        uint128 reserved_notional;
        uint128 max_capacity;
    }
}

#[cfg(feature = "ethexe")]
impl From<LpAccountSol> for LpAccount {
    fn from(value: LpAccountSol) -> Self {
        Self {
            shares: value.shares,
            deposited: value.deposited,
        }
    }
}

#[cfg(feature = "ethexe")]
impl From<LpAccount> for LpAccountSol {
    fn from(value: LpAccount) -> Self {
        Self {
            shares: value.shares,
            deposited: value.deposited,
        }
    }
}

#[cfg(feature = "ethexe")]
impl SolValue for LpAccount {
    type SolType = LpAccountSol;
}

#[cfg(feature = "ethexe")]
impl SolTypeValue<LpAccountSol> for LpAccount {
    fn stv_to_tokens(&self) -> <LpAccountSol as SolType>::Token<'_> {
        let value: LpAccountSol = (*self).into();
        <LpAccountSol as SolTypeValue<LpAccountSol>>::stv_to_tokens(&value)
    }

    fn stv_abi_encode_packed_to(&self, out: &mut sails_rs::Vec<u8>) {
        let value: LpAccountSol = (*self).into();
        <LpAccountSol as SolTypeValue<LpAccountSol>>::stv_abi_encode_packed_to(&value, out);
    }

    fn stv_eip712_data_word(&self) -> sails_rs::alloy_sol_types::Word {
        let value: LpAccountSol = (*self).into();
        <LpAccountSol as SolTypeValue<LpAccountSol>>::stv_eip712_data_word(&value)
    }
}

#[cfg(feature = "ethexe")]
impl From<PoolStateSol> for PoolState {
    fn from(value: PoolStateSol) -> Self {
        Self {
            total_liquidity: value.total_liquidity,
            total_shares: value.total_shares,
            reserved_notional: value.reserved_notional,
            max_capacity: value.max_capacity,
        }
    }
}

#[cfg(feature = "ethexe")]
impl From<PoolState> for PoolStateSol {
    fn from(value: PoolState) -> Self {
        Self {
            total_liquidity: value.total_liquidity,
            total_shares: value.total_shares,
            reserved_notional: value.reserved_notional,
            max_capacity: value.max_capacity,
        }
    }
}

#[cfg(feature = "ethexe")]
impl SolValue for PoolState {
    type SolType = PoolStateSol;
}

#[cfg(feature = "ethexe")]
impl SolTypeValue<PoolStateSol> for PoolState {
    fn stv_to_tokens(&self) -> <PoolStateSol as SolType>::Token<'_> {
        let value: PoolStateSol = (*self).into();
        <PoolStateSol as SolTypeValue<PoolStateSol>>::stv_to_tokens(&value)
    }

    fn stv_abi_encode_packed_to(&self, out: &mut sails_rs::Vec<u8>) {
        let value: PoolStateSol = (*self).into();
        <PoolStateSol as SolTypeValue<PoolStateSol>>::stv_abi_encode_packed_to(&value, out);
    }

    fn stv_eip712_data_word(&self) -> sails_rs::alloy_sol_types::Word {
        let value: PoolStateSol = (*self).into();
        <PoolStateSol as SolTypeValue<PoolStateSol>>::stv_eip712_data_word(&value)
    }
}
