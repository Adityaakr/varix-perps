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
#[cfg(feature = "sessions")]
use session_registry_client::{
    session_registry::SessionRegistry as SessionRegistryCalls,
    SessionAction as SessionRegistryAction,
    SessionRegistryClient,
    SessionRegistryClientProgram,
};
use varix_shared::AccountSnapshot;

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum VaultError {
    InsufficientFreeBalance,
    InsufficientLockedBalance,
    SessionRegistryQueryFailed,
    TokenTransferFailed,
    Unauthorized,
    ZeroAmount,
    MarketAlreadyAuthorized,
    MarketNotAuthorized,
    MissingTokenProgram,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct VaultTotals {
    pub total_free: u128,
    pub total_locked: u128,
}

#[derive(Default)]
pub struct VaultState {
    owner: ActorId,
    session_registry: Option<ActorId>,
    token_program: Option<ActorId>,
    free_balances: BTreeMap<ActorId, u128>,
    locked_balances: BTreeMap<ActorId, u128>,
    authorized_markets: BTreeMap<ActorId, bool>,
}

pub struct VaultService<'a> {
    state: &'a RefCell<VaultState>,
}

enum TraderAction {
    AddMargin,
    Withdraw,
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

impl<'a> VaultService<'a> {
    pub fn new(state: &'a RefCell<VaultState>) -> Self {
        Self { state }
    }

    fn require_owner(state: &VaultState) -> Result<(), VaultError> {
        if msg::source() == state.owner {
            Ok(())
        } else {
            Err(VaultError::Unauthorized)
        }
    }

    fn require_market(state: &VaultState) -> Result<(), VaultError> {
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
            Err(VaultError::Unauthorized)
        }
    }

    fn require_positive(amount: u128) -> Result<(), VaultError> {
        if amount == 0 {
            Err(VaultError::ZeroAmount)
        } else {
            Ok(())
        }
    }

    #[cfg(feature = "sessions")]
    async fn resolve_trader(&self, action: TraderAction) -> Result<ActorId, VaultError> {
        let caller = msg::source();
        let session_registry = self.state.borrow().session_registry;
        let Some(session_registry) = session_registry else {
            return Ok(caller);
        };

        let action = match action {
            TraderAction::AddMargin => SessionRegistryAction::AddMargin,
            TraderAction::Withdraw => SessionRegistryAction::Withdraw,
        };

        let session_registry = SessionRegistryClientProgram::client(session_registry);
        let session_registry = session_registry.session_registry();
        let owner = session_registry
            .owner_for(caller)
            .await
            .map_err(|_| VaultError::SessionRegistryQueryFailed)?;
        let Some(owner) = owner else {
            return Ok(caller);
        };

        let valid = session_registry
            .validate(owner, caller, action)
            .await
            .map_err(|_| VaultError::SessionRegistryQueryFailed)?;
        if valid {
            Ok(owner)
        } else {
            Err(VaultError::Unauthorized)
        }
    }

    #[cfg(not(feature = "sessions"))]
    async fn resolve_trader(&self, _action: TraderAction) -> Result<ActorId, VaultError> {
        Ok(msg::source())
    }
}

#[sails_rs::service]
impl VaultService<'_> {
    #[export(unwrap_result)]
    pub async fn deposit(&mut self, amount: u128) -> Result<AccountSnapshot, VaultError> {
        VaultService::require_positive(amount)?;

        let trader = self.resolve_trader(TraderAction::AddMargin).await?;
        let token_program = self
            .state
            .borrow()
            .token_program
            .ok_or(VaultError::MissingTokenProgram)?;
        let token = DemoUsdcVftClientProgram::client(token_program);
        let mut token = token.token();
        let transferred = token
            .transfer_from(trader, exec::program_id(), amount)
            .await
            .map_err(|_| VaultError::TokenTransferFailed)?;
        if !transferred {
            return Err(VaultError::TokenTransferFailed);
        }

        let mut state = self.state.borrow_mut();
        let free = state.free_balances.entry(trader).or_default();
        *free = free.saturating_add(amount);

        let snapshot = AccountSnapshot {
            free: *free,
            locked: state.locked_balances.get(&trader).copied().unwrap_or_default(),
        };
        Ok(snapshot)
    }

    #[export(unwrap_result)]
    pub async fn withdraw(&mut self, amount: u128) -> Result<AccountSnapshot, VaultError> {
        VaultService::require_positive(amount)?;

        let trader = self.resolve_trader(TraderAction::Withdraw).await?;
        let (snapshot, token_program) = {
            let mut state = self.state.borrow_mut();
            let free = state.free_balances.entry(trader).or_default();
            if *free < amount {
                return Err(VaultError::InsufficientFreeBalance);
            }
            *free -= amount;

            (
                AccountSnapshot {
                    free: *free,
                    locked: state.locked_balances.get(&trader).copied().unwrap_or_default(),
                },
                state.token_program.ok_or(VaultError::MissingTokenProgram)?,
            )
        };

        let token = DemoUsdcVftClientProgram::client(token_program);
        let mut token = token.token();
        let transferred = token
            .transfer(trader, amount)
            .await
            .map_err(|_| VaultError::TokenTransferFailed)?;
        if !transferred {
            return Err(VaultError::TokenTransferFailed);
        }

        Ok(snapshot)
    }

    async fn settle_position_inner(
        &mut self,
        trader: ActorId,
        released_margin: u128,
        payout: u128,
        pool: Option<ActorId>,
    ) -> Result<AccountSnapshot, VaultError> {
        VaultService::require_positive(released_margin)?;

        let (snapshot, token_program, loss_to_pool) = {
            let mut state = self.state.borrow_mut();
            VaultService::require_market(&state)?;
            let current_locked = state
                .locked_balances
                .get(&trader)
                .copied()
                .unwrap_or_default();
            if current_locked < released_margin {
                return Err(VaultError::InsufficientLockedBalance);
            }
            let next_locked = current_locked - released_margin;
            let next_free = state
                .free_balances
                .get(&trader)
                .copied()
                .unwrap_or_default()
                .saturating_add(payout);
            state.locked_balances.insert(trader, next_locked);
            state.free_balances.insert(trader, next_free);

            (
                AccountSnapshot {
                    free: next_free,
                    locked: next_locked,
                },
                state.token_program.ok_or(VaultError::MissingTokenProgram)?,
                released_margin.saturating_sub(payout),
            )
        };

        if loss_to_pool > 0 {
            let pool = pool.ok_or(VaultError::Unauthorized)?;
            let token = DemoUsdcVftClientProgram::client(token_program);
            let mut token = token.token();
            let transferred = token
                .transfer(pool, loss_to_pool)
                .await
                .map_err(|_| VaultError::TokenTransferFailed)?;
            if !transferred {
                return Err(VaultError::TokenTransferFailed);
            }
        }

        Ok(snapshot)
    }

    #[export(unwrap_result)]
    pub async fn settle_position(
        &mut self,
        trader: ActorId,
        released_margin: u128,
        payout: u128,
        pool: ActorId,
    ) -> Result<AccountSnapshot, VaultError> {
        self.settle_position_inner(trader, released_margin, payout, optional_actor_id(pool))
            .await
    }

    #[export(unwrap_result)]
    pub fn authorize_market(&mut self, market: ActorId) -> Result<(), VaultError> {
        let mut state = self.state.borrow_mut();
        VaultService::require_owner(&state)?;
        if state.authorized_markets.insert(market, true).is_some() {
            return Err(VaultError::MarketAlreadyAuthorized);
        }
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn revoke_market(&mut self, market: ActorId) -> Result<(), VaultError> {
        let mut state = self.state.borrow_mut();
        VaultService::require_owner(&state)?;
        if state.authorized_markets.remove(&market).is_none() {
            return Err(VaultError::MarketNotAuthorized);
        }
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn lock_margin(
        &mut self,
        trader: ActorId,
        amount: u128,
    ) -> Result<AccountSnapshot, VaultError> {
        VaultService::require_positive(amount)?;

        let mut state = self.state.borrow_mut();
        VaultService::require_market(&state)?;

        let free_balance = {
            let free = state.free_balances.entry(trader).or_default();
            if *free < amount {
                return Err(VaultError::InsufficientFreeBalance);
            }
            *free -= amount;
            *free
        };

        let locked_balance = {
            let locked = state.locked_balances.entry(trader).or_default();
            *locked = locked.saturating_add(amount);
            *locked
        };
        let snapshot = AccountSnapshot {
            free: free_balance,
            locked: locked_balance,
        };

        Ok(snapshot)
    }

    #[export(unwrap_result)]
    pub fn release_margin(
        &mut self,
        trader: ActorId,
        amount: u128,
    ) -> Result<AccountSnapshot, VaultError> {
        VaultService::require_positive(amount)?;

        let mut state = self.state.borrow_mut();
        VaultService::require_market(&state)?;

        let locked_balance = {
            let locked = state.locked_balances.entry(trader).or_default();
            if *locked < amount {
                return Err(VaultError::InsufficientLockedBalance);
            }
            *locked -= amount;
            *locked
        };

        let free_balance = {
            let free = state.free_balances.entry(trader).or_default();
            *free = free.saturating_add(amount);
            *free
        };
        let snapshot = AccountSnapshot {
            free: free_balance,
            locked: locked_balance,
        };

        Ok(snapshot)
    }

    async fn slash_for_liquidation_inner(
        &mut self,
        trader: ActorId,
        amount: u128,
        pool: Option<ActorId>,
    ) -> Result<AccountSnapshot, VaultError> {
        VaultService::require_positive(amount)?;

        let (snapshot, token_program) = {
            let mut state = self.state.borrow_mut();
            VaultService::require_market(&state)?;

            let free_balance = state.free_balances.get(&trader).copied().unwrap_or_default();
            let locked_balance = {
                let locked = state.locked_balances.entry(trader).or_default();
                if *locked < amount {
                    return Err(VaultError::InsufficientLockedBalance);
                }
                *locked -= amount;
                *locked
            };
            (
                AccountSnapshot {
                    free: free_balance,
                    locked: locked_balance,
                },
                state.token_program.ok_or(VaultError::MissingTokenProgram)?,
            )
        };

        let pool = pool.ok_or(VaultError::Unauthorized)?;
        let token = DemoUsdcVftClientProgram::client(token_program);
        let mut token = token.token();
        let transferred = token
            .transfer(pool, amount)
            .await
            .map_err(|_| VaultError::TokenTransferFailed)?;
        if !transferred {
            return Err(VaultError::TokenTransferFailed);
        }

        Ok(snapshot)
    }

    #[export(unwrap_result)]
    pub async fn slash_for_liquidation(
        &mut self,
        trader: ActorId,
        amount: u128,
        pool: ActorId,
    ) -> Result<AccountSnapshot, VaultError> {
        self.slash_for_liquidation_inner(trader, amount, optional_actor_id(pool))
            .await
    }

    #[export]
    pub fn account(&self, trader: ActorId) -> AccountSnapshot {
        let state = self.state.borrow();
        AccountSnapshot {
            free: state.free_balances.get(&trader).copied().unwrap_or_default(),
            locked: state.locked_balances.get(&trader).copied().unwrap_or_default(),
        }
    }

    #[export]
    pub fn totals(&self) -> VaultTotals {
        let state = self.state.borrow();
        VaultTotals {
            total_free: state.free_balances.values().copied().sum(),
            total_locked: state.locked_balances.values().copied().sum(),
        }
    }
}

pub struct Program {
    state: RefCell<VaultState>,
}

#[sails_rs::program]
impl Program {
    pub fn create(owner: ActorId, session_registry: ActorId, token_program: ActorId) -> Self {
        Self {
            state: RefCell::new(VaultState {
                owner,
                session_registry: optional_actor_id(session_registry),
                token_program: optional_actor_id(token_program),
                ..Default::default()
            }),
        }
    }

    pub fn vault(&self) -> VaultService<'_> {
        VaultService::new(&self.state)
    }
}

#[cfg(feature = "ethexe")]
alloy_sol_types::sol! {
    struct VaultTotalsSol {
        uint128 total_free;
        uint128 total_locked;
    }
}

#[cfg(feature = "ethexe")]
impl From<VaultTotalsSol> for VaultTotals {
    fn from(value: VaultTotalsSol) -> Self {
        Self {
            total_free: value.total_free,
            total_locked: value.total_locked,
        }
    }
}

#[cfg(feature = "ethexe")]
impl From<VaultTotals> for VaultTotalsSol {
    fn from(value: VaultTotals) -> Self {
        Self {
            total_free: value.total_free,
            total_locked: value.total_locked,
        }
    }
}

#[cfg(feature = "ethexe")]
impl SolValue for VaultTotals {
    type SolType = VaultTotalsSol;
}

#[cfg(feature = "ethexe")]
impl SolTypeValue<VaultTotalsSol> for VaultTotals {
    fn stv_to_tokens(&self) -> <VaultTotalsSol as SolType>::Token<'_> {
        let value: VaultTotalsSol = (*self).into();
        <VaultTotalsSol as SolTypeValue<VaultTotalsSol>>::stv_to_tokens(&value)
    }

    fn stv_abi_encode_packed_to(&self, out: &mut sails_rs::Vec<u8>) {
        let value: VaultTotalsSol = (*self).into();
        <VaultTotalsSol as SolTypeValue<VaultTotalsSol>>::stv_abi_encode_packed_to(&value, out);
    }

    fn stv_eip712_data_word(&self) -> sails_rs::alloy_sol_types::Word {
        let value: VaultTotalsSol = (*self).into();
        <VaultTotalsSol as SolTypeValue<VaultTotalsSol>>::stv_eip712_data_word(&value)
    }
}
