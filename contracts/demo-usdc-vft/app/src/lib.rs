#![no_std]
#![allow(static_mut_refs)]

use sails_rs::{
    collections::BTreeMap,
    gstd::msg,
    prelude::*,
};

#[cfg(feature = "ethexe")]
use core::marker::PhantomData;
#[cfg(not(feature = "ethexe"))]
use sails_rs::cell::RefCell;

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum TokenError {
    InsufficientAllowance,
    InsufficientBalance,
    Overflow,
    Unauthorized,
    ZeroAmount,
}

#[derive(Default)]
pub struct TokenState {
    owner: ActorId,
    total_supply: u128,
    balances: BTreeMap<ActorId, u128>,
    allowances: BTreeMap<(ActorId, ActorId), u128>,
}

const DEMO_USDC_DECIMALS: u16 = 6;

#[cfg(feature = "ethexe")]
static mut TOKEN_STATE: Option<TokenState> = None;

pub struct TokenService<'a> {
    #[cfg(not(feature = "ethexe"))]
    state: &'a RefCell<TokenState>,
    #[cfg(feature = "ethexe")]
    marker: PhantomData<&'a ()>,
}

impl<'a> TokenService<'a> {
    #[cfg(not(feature = "ethexe"))]
    pub fn new(state: &'a RefCell<TokenState>) -> Self {
        Self { state }
    }

    #[cfg(feature = "ethexe")]
    pub fn new() -> Self {
        Self {
            marker: PhantomData,
        }
    }
}

fn require_positive(amount: u128) -> Result<(), TokenError> {
    if amount == 0 {
        Err(TokenError::ZeroAmount)
    } else {
        Ok(())
    }
}

fn apply_transfer(
    state: &mut TokenState,
    from: ActorId,
    to: ActorId,
    value: u128,
) -> Result<(), TokenError> {
    let from_balance = state.balances.entry(from).or_default();
    if *from_balance < value {
        return Err(TokenError::InsufficientBalance);
    }
    *from_balance -= value;

    let to_balance = state.balances.entry(to).or_default();
    *to_balance = to_balance
        .checked_add(value)
        .ok_or(TokenError::Overflow)?;
    Ok(())
}

impl TokenService<'_> {
    fn with_state<R>(&self, f: impl FnOnce(&TokenState) -> R) -> R {
        #[cfg(feature = "ethexe")]
        unsafe {
            f(TOKEN_STATE.as_ref().expect("token state must be initialized"))
        }

        #[cfg(not(feature = "ethexe"))]
        {
            let state = self.state.borrow();
            f(&state)
        }
    }

    fn with_state_mut<R>(&mut self, f: impl FnOnce(&mut TokenState) -> R) -> R {
        #[cfg(feature = "ethexe")]
        unsafe {
            f(TOKEN_STATE.as_mut().expect("token state must be initialized"))
        }

        #[cfg(not(feature = "ethexe"))]
        {
            let mut state = self.state.borrow_mut();
            f(&mut state)
        }
    }
}

#[sails_rs::service]
impl TokenService<'_> {
    #[export(unwrap_result)]
    pub fn mint(&mut self, amount: u128) -> Result<u128, TokenError> {
        require_positive(amount)?;
        let to = msg::source();
        self.with_state_mut(|state| {
            let next_supply = state
                .total_supply
                .checked_add(amount)
                .ok_or(TokenError::Overflow)?;
            let next_balance = state
                .balances
                .get(&to)
                .copied()
                .unwrap_or_default()
                .checked_add(amount)
                .ok_or(TokenError::Overflow)?;
            state.total_supply = next_supply;
            state.balances.insert(to, next_balance);
            Ok(next_balance)
        })
    }

    #[export(unwrap_result)]
    pub fn mint_to(&mut self, to: ActorId, amount: u128) -> Result<u128, TokenError> {
        require_positive(amount)?;
        self.with_state_mut(|state| {
            if msg::source() != state.owner {
                return Err(TokenError::Unauthorized);
            }

            let next_supply = state
                .total_supply
                .checked_add(amount)
                .ok_or(TokenError::Overflow)?;
            let next_balance = state
                .balances
                .get(&to)
                .copied()
                .unwrap_or_default()
                .checked_add(amount)
                .ok_or(TokenError::Overflow)?;
            state.total_supply = next_supply;
            state.balances.insert(to, next_balance);
            Ok(next_balance)
        })
    }

    #[export(unwrap_result)]
    pub fn approve(&mut self, spender: ActorId, value: u128) -> Result<bool, TokenError> {
        let owner = msg::source();
        self.with_state_mut(|state| {
            state.allowances.insert((owner, spender), value);
            Ok(true)
        })
    }

    #[export(unwrap_result)]
    pub fn transfer(&mut self, to: ActorId, value: u128) -> Result<bool, TokenError> {
        require_positive(value)?;
        let from = msg::source();
        self.with_state_mut(|state| {
            apply_transfer(state, from, to, value)?;
            Ok(true)
        })
    }

    #[export(unwrap_result)]
    pub fn transfer_from(
        &mut self,
        from: ActorId,
        to: ActorId,
        value: u128,
    ) -> Result<bool, TokenError> {
        require_positive(value)?;
        let spender = msg::source();
        self.with_state_mut(|state| {
            let remaining_allowance = state
                .allowances
                .get(&(from, spender))
                .copied()
                .unwrap_or_default();
            if remaining_allowance < value {
                return Err(TokenError::InsufficientAllowance);
            }
            state
                .allowances
                .insert((from, spender), remaining_allowance - value);
            apply_transfer(state, from, to, value)?;
            Ok(true)
        })
    }

    #[export]
    pub fn balance_of(&self, owner: ActorId) -> u128 {
        self.with_state(|state| state.balances.get(&owner).copied().unwrap_or_default())
    }

    #[export]
    pub fn allowance(&self, owner: ActorId, spender: ActorId) -> u128 {
        self.with_state(|state| {
            state
                .allowances
                .get(&(owner, spender))
                .copied()
                .unwrap_or_default()
        })
    }

    #[export]
    pub fn total_supply(&self) -> u128 {
        self.with_state(|state| state.total_supply)
    }

    #[export]
    pub fn decimals(&self) -> u16 {
        DEMO_USDC_DECIMALS
    }
}

#[cfg(feature = "ethexe")]
pub struct Program;

#[cfg(not(feature = "ethexe"))]
pub struct Program {
    state: RefCell<TokenState>,
}

#[sails_rs::program]
impl Program {
    pub fn create(owner: ActorId) -> Self {
        #[cfg(feature = "ethexe")]
        unsafe {
            TOKEN_STATE = Some(TokenState {
                owner,
                ..Default::default()
            });
            Self
        }

        #[cfg(not(feature = "ethexe"))]
        {
            Self {
                state: RefCell::new(TokenState {
                    owner,
                    ..Default::default()
                }),
            }
        }
    }

    pub fn token(&self) -> TokenService<'_> {
        #[cfg(feature = "ethexe")]
        {
            TokenService::new()
        }

        #[cfg(not(feature = "ethexe"))]
        {
            TokenService::new(&self.state)
        }
    }
}
