#![no_std]

extern crate alloc;

use parity_scale_codec::{Decode, Encode, MaxEncodedLen};
use scale_info::TypeInfo;

pub const PRICE_SCALE: u128 = 100_000_000;
pub const COLLATERAL_SCALE: u128 = 1_000_000;
pub const PRICE_TO_COLLATERAL_SCALE: u128 = PRICE_SCALE / COLLATERAL_SCALE;
pub const BPS_DIVISOR: u128 = 10_000;

#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Encode,
    Decode,
    TypeInfo,
    MaxEncodedLen,
)]
pub enum Asset {
    Btc,
    Eth,
    Sol,
}

#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Encode,
    Decode,
    TypeInfo,
    MaxEncodedLen,
)]
pub enum Side {
    Long,
    Short,
}

impl Side {
    pub fn direction(self) -> i128 {
        match self {
            Self::Long => 1,
            Self::Short => -1,
        }
    }

    pub fn from_size(size: i128) -> Option<Self> {
        if size > 0 {
            Some(Self::Long)
        } else if size < 0 {
            Some(Self::Short)
        } else {
            None
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo, MaxEncodedLen)]
pub struct Position {
    pub size: i128,
    pub entry_price: u128,
    pub margin: u128,
    pub leverage: u8,
    pub last_funding_rate_bps: i128,
    pub opened_at: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Encode, Decode, TypeInfo, MaxEncodedLen)]
pub struct OracleQuote {
    pub price: u128,
    pub timestamp: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Encode, Decode, TypeInfo, MaxEncodedLen)]
pub struct AccountSnapshot {
    pub free: u128,
    pub locked: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Encode, Decode, TypeInfo, MaxEncodedLen)]
pub struct MarketRiskConfig {
    pub initial_margin_bps: u16,
    pub maintenance_margin_bps: u16,
    pub max_leverage: u8,
    pub funding_interval_blocks: u32,
    pub liquidation_delay_blocks: u32,
    pub max_funding_velocity_bps: i16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Encode, Decode, TypeInfo, MaxEncodedLen)]
pub struct MarketSnapshot {
    pub mark_price: u128,
    pub index_price: u128,
    pub funding_rate_bps: i128,
    pub cumulative_funding_rate_bps: i128,
    pub open_interest_long: u128,
    pub open_interest_short: u128,
}

pub fn notional_to_collateral(size: u128, price: u128) -> Option<u128> {
    size.checked_mul(price)?
        .checked_div(PRICE_SCALE)?
        .checked_div(PRICE_TO_COLLATERAL_SCALE)
}

pub fn pnl_to_collateral(size: i128, entry_price: u128, exit_price: u128) -> Option<i128> {
    let delta = exit_price as i128 - entry_price as i128;
    delta.checked_mul(size)?
        .checked_div(PRICE_SCALE as i128)?
        .checked_div(PRICE_TO_COLLATERAL_SCALE as i128)
}

pub fn collateral_for_leverage(notional: u128, leverage: u8) -> Option<u128> {
    if leverage == 0 {
        return None;
    }
    notional.checked_div(leverage as u128)
}

pub fn margin_requirement(notional: u128, bps: u16) -> Option<u128> {
    notional.checked_mul(bps as u128)?.checked_div(BPS_DIVISOR)
}
