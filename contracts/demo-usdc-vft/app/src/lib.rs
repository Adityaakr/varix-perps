#![no_std]

use sails_rs::{
    cell::RefCell,
    collections::BTreeMap,
    gstd::msg,
    prelude::*,
};

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

#[sails_rs::event]
#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum TokenEvent {
    Transfer {
        from: ActorId,
        to: ActorId,
        value: u128,
    },
    Approval {
        owner: ActorId,
        spender: ActorId,
        value: u128,
    },
    Minted {
        to: ActorId,
        value: u128,
    },
}

#[derive(Default)]
pub struct TokenState {
    owner: ActorId,
    name: String,
    symbol: String,
    decimals: u8,
    total_supply: u128,
    balances: BTreeMap<ActorId, u128>,
    allowances: BTreeMap<(ActorId, ActorId), u128>,
}

pub struct TokenService<'a> {
    state: &'a RefCell<TokenState>,
}

impl<'a> TokenService<'a> {
    pub fn new(state: &'a RefCell<TokenState>) -> Self {
        Self { state }
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
}

#[sails_rs::service(events = TokenEvent)]
impl TokenService<'_> {
    #[export(unwrap_result)]
    pub fn mint(&mut self, amount: u128) -> Result<u128, TokenError> {
        TokenService::require_positive(amount)?;
        let to = msg::source();
        let mut state = self.state.borrow_mut();
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
        self.emit_event(TokenEvent::Minted { to, value: amount })
            .expect("event emission should succeed");
        self.emit_event(TokenEvent::Transfer {
            from: ActorId::zero(),
            to,
            value: amount,
        })
        .expect("event emission should succeed");
        Ok(next_balance)
    }

    #[export(unwrap_result)]
    pub fn mint_to(&mut self, to: ActorId, amount: u128) -> Result<u128, TokenError> {
        TokenService::require_positive(amount)?;
        let mut state = self.state.borrow_mut();
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
        self.emit_event(TokenEvent::Minted { to, value: amount })
            .expect("event emission should succeed");
        self.emit_event(TokenEvent::Transfer {
            from: ActorId::zero(),
            to,
            value: amount,
        })
        .expect("event emission should succeed");
        Ok(next_balance)
    }

    #[export(unwrap_result)]
    pub fn approve(&mut self, spender: ActorId, value: u128) -> Result<bool, TokenError> {
        let owner = msg::source();
        self.state.borrow_mut().allowances.insert((owner, spender), value);
        self.emit_event(TokenEvent::Approval {
            owner,
            spender,
            value,
        })
        .expect("event emission should succeed");
        Ok(true)
    }

    #[export(unwrap_result)]
    pub fn transfer(&mut self, to: ActorId, value: u128) -> Result<bool, TokenError> {
        TokenService::require_positive(value)?;
        let from = msg::source();
        let mut state = self.state.borrow_mut();
        TokenService::apply_transfer(&mut state, from, to, value)?;
        self.emit_event(TokenEvent::Transfer { from, to, value })
            .expect("event emission should succeed");
        Ok(true)
    }

    #[export(unwrap_result)]
    pub fn transfer_from(
        &mut self,
        from: ActorId,
        to: ActorId,
        value: u128,
    ) -> Result<bool, TokenError> {
        TokenService::require_positive(value)?;
        let spender = msg::source();
        let mut state = self.state.borrow_mut();
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
        TokenService::apply_transfer(&mut state, from, to, value)?;
        self.emit_event(TokenEvent::Approval {
            owner: from,
            spender,
            value: remaining_allowance - value,
        })
        .expect("event emission should succeed");
        self.emit_event(TokenEvent::Transfer { from, to, value })
            .expect("event emission should succeed");
        Ok(true)
    }

    #[export]
    pub fn balance_of(&self, owner: ActorId) -> u128 {
        self.state
            .borrow()
            .balances
            .get(&owner)
            .copied()
            .unwrap_or_default()
    }

    #[export]
    pub fn allowance(&self, owner: ActorId, spender: ActorId) -> u128 {
        self.state
            .borrow()
            .allowances
            .get(&(owner, spender))
            .copied()
            .unwrap_or_default()
    }

    #[export]
    pub fn total_supply(&self) -> u128 {
        self.state.borrow().total_supply
    }

    #[export]
    pub fn name(&self) -> String {
        self.state.borrow().name.clone()
    }

    #[export]
    pub fn symbol(&self) -> String {
        self.state.borrow().symbol.clone()
    }

    #[export]
    pub fn decimals(&self) -> u8 {
        self.state.borrow().decimals
    }
}

pub struct Program {
    state: RefCell<TokenState>,
}

#[sails_rs::program]
impl Program {
    pub fn create(owner: ActorId, name: String, symbol: String, decimals: u8) -> Self {
        Self {
            state: RefCell::new(TokenState {
                owner,
                name,
                symbol,
                decimals,
                ..Default::default()
            }),
        }
    }

    pub fn token(&self) -> TokenService<'_> {
        TokenService::new(&self.state)
    }
}
