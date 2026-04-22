#![no_std]

use demo_usdc_vft_client::{
    token::Token as TokenCalls,
    DemoUsdcVftClient,
    DemoUsdcVftClientProgram,
};
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

#[sails_rs::event]
#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum PoolEvent {
    LiquidityDeposited {
        provider: ActorId,
        amount: u128,
        shares: u128,
    },
    LiquidityWithdrawn {
        provider: ActorId,
        amount: u128,
        shares: u128,
    },
    CapacityReserved {
        market: ActorId,
        amount: u128,
        reserved_notional: u128,
    },
    CapacityReleased {
        market: ActorId,
        amount: u128,
        reserved_notional: u128,
    },
    ProfitPaidToVault {
        market: ActorId,
        vault: ActorId,
        amount: u128,
    },
    MarketAuthorizationChanged {
        market: ActorId,
        enabled: bool,
    },
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

#[sails_rs::service(events = PoolEvent)]
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
        self.emit_event(PoolEvent::LiquidityDeposited {
            provider,
            amount,
            shares,
        })
        .expect("event emission should succeed");
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

        self.emit_event(PoolEvent::LiquidityWithdrawn {
            provider,
            amount,
            shares,
        })
        .expect("event emission should succeed");
        Ok(snapshot)
    }

    #[export(unwrap_result)]
    pub fn authorize_market(&mut self, market: ActorId) -> Result<(), PoolError> {
        let mut state = self.state.borrow_mut();
        PoolService::require_owner(&state)?;
        if state.authorized_markets.insert(market, true).is_some() {
            return Err(PoolError::MarketAlreadyAuthorized);
        }
        self.emit_event(PoolEvent::MarketAuthorizationChanged {
            market,
            enabled: true,
        })
        .expect("event emission should succeed");
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn revoke_market(&mut self, market: ActorId) -> Result<(), PoolError> {
        let mut state = self.state.borrow_mut();
        PoolService::require_owner(&state)?;
        if state.authorized_markets.remove(&market).is_none() {
            return Err(PoolError::MarketNotAuthorized);
        }
        self.emit_event(PoolEvent::MarketAuthorizationChanged {
            market,
            enabled: false,
        })
        .expect("event emission should succeed");
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
        self.emit_event(PoolEvent::CapacityReserved {
            market: msg::source(),
            amount,
            reserved_notional: state.reserved_notional,
        })
        .expect("event emission should succeed");
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
        self.emit_event(PoolEvent::CapacityReleased {
            market: msg::source(),
            amount,
            reserved_notional: state.reserved_notional,
        })
        .expect("event emission should succeed");
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
        self.emit_event(PoolEvent::ProfitPaidToVault {
            market: msg::source(),
            vault,
            amount,
        })
        .expect("event emission should succeed");
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
