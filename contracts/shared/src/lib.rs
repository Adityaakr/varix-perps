#![no_std]

extern crate alloc;

#[cfg(feature = "ethexe")]
use alloy_sol_types::{SolType, SolValue, private::SolTypeValue};
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
    pub leverage: u16,
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
    pub max_leverage: u16,
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

pub fn collateral_for_leverage(notional: u128, leverage: u16) -> Option<u128> {
    if leverage == 0 {
        return None;
    }
    notional.checked_div(leverage as u128)
}

pub fn margin_requirement(notional: u128, bps: u16) -> Option<u128> {
    notional.checked_mul(bps as u128)?.checked_div(BPS_DIVISOR)
}

#[cfg(feature = "ethexe")]
alloy_sol_types::sol! {
    enum AssetSol {
        Btc,
        Eth,
        Sol
    }

    enum SideSol {
        Long,
        Short
    }

    struct AccountSnapshotSol {
        uint128 free;
        uint128 locked;
    }

    struct MarketRiskConfigSol {
        uint16 initial_margin_bps;
        uint16 maintenance_margin_bps;
        uint16 max_leverage;
        uint32 funding_interval_blocks;
        uint32 liquidation_delay_blocks;
        int16 max_funding_velocity_bps;
    }

    struct PositionSol {
        int128 size;
        uint128 entry_price;
        uint128 margin;
        uint16 leverage;
        int128 last_funding_rate_bps;
        uint64 opened_at;
    }

    struct MarketSnapshotSol {
        uint128 mark_price;
        uint128 index_price;
        int128 funding_rate_bps;
        int128 cumulative_funding_rate_bps;
        uint128 open_interest_long;
        uint128 open_interest_short;
    }
}

#[cfg(feature = "ethexe")]
impl From<AssetSol> for Asset {
    fn from(value: AssetSol) -> Self {
        match value {
            AssetSol::Btc => Self::Btc,
            AssetSol::Eth => Self::Eth,
            AssetSol::Sol => Self::Sol,
            AssetSol::__Invalid => Self::Btc,
        }
    }
}

#[cfg(feature = "ethexe")]
impl From<Asset> for AssetSol {
    fn from(value: Asset) -> Self {
        match value {
            Asset::Btc => Self::Btc,
            Asset::Eth => Self::Eth,
            Asset::Sol => Self::Sol,
        }
    }
}

#[cfg(feature = "ethexe")]
impl SolValue for Asset {
    type SolType = AssetSol;
}

#[cfg(feature = "ethexe")]
impl SolTypeValue<AssetSol> for Asset {
    fn stv_to_tokens(&self) -> <AssetSol as SolType>::Token<'_> {
        let value: AssetSol = (*self).into();
        <AssetSol as SolTypeValue<AssetSol>>::stv_to_tokens(&value)
    }

    fn stv_abi_encode_packed_to(&self, out: &mut sails_rs::Vec<u8>) {
        let value: AssetSol = (*self).into();
        <AssetSol as SolTypeValue<AssetSol>>::stv_abi_encode_packed_to(&value, out);
    }

    fn stv_eip712_data_word(&self) -> sails_rs::alloy_sol_types::Word {
        let value: AssetSol = (*self).into();
        <AssetSol as SolTypeValue<AssetSol>>::stv_eip712_data_word(&value)
    }
}

#[cfg(feature = "ethexe")]
impl From<SideSol> for Side {
    fn from(value: SideSol) -> Self {
        match value {
            SideSol::Long => Self::Long,
            SideSol::Short => Self::Short,
            SideSol::__Invalid => Self::Long,
        }
    }
}

#[cfg(feature = "ethexe")]
impl From<Side> for SideSol {
    fn from(value: Side) -> Self {
        match value {
            Side::Long => Self::Long,
            Side::Short => Self::Short,
        }
    }
}

#[cfg(feature = "ethexe")]
impl SolValue for Side {
    type SolType = SideSol;
}

#[cfg(feature = "ethexe")]
impl SolTypeValue<SideSol> for Side {
    fn stv_to_tokens(&self) -> <SideSol as SolType>::Token<'_> {
        let value: SideSol = (*self).into();
        <SideSol as SolTypeValue<SideSol>>::stv_to_tokens(&value)
    }

    fn stv_abi_encode_packed_to(&self, out: &mut sails_rs::Vec<u8>) {
        let value: SideSol = (*self).into();
        <SideSol as SolTypeValue<SideSol>>::stv_abi_encode_packed_to(&value, out);
    }

    fn stv_eip712_data_word(&self) -> sails_rs::alloy_sol_types::Word {
        let value: SideSol = (*self).into();
        <SideSol as SolTypeValue<SideSol>>::stv_eip712_data_word(&value)
    }
}

#[cfg(feature = "ethexe")]
impl From<AccountSnapshotSol> for AccountSnapshot {
    fn from(value: AccountSnapshotSol) -> Self {
        Self {
            free: value.free,
            locked: value.locked,
        }
    }
}

#[cfg(feature = "ethexe")]
impl From<AccountSnapshot> for AccountSnapshotSol {
    fn from(value: AccountSnapshot) -> Self {
        Self {
            free: value.free,
            locked: value.locked,
        }
    }
}

#[cfg(feature = "ethexe")]
impl SolValue for AccountSnapshot {
    type SolType = AccountSnapshotSol;
}

#[cfg(feature = "ethexe")]
impl SolTypeValue<AccountSnapshotSol> for AccountSnapshot {
    fn stv_to_tokens(&self) -> <AccountSnapshotSol as SolType>::Token<'_> {
        let value: AccountSnapshotSol = (*self).into();
        <AccountSnapshotSol as SolTypeValue<AccountSnapshotSol>>::stv_to_tokens(&value)
    }

    fn stv_abi_encode_packed_to(&self, out: &mut sails_rs::Vec<u8>) {
        let value: AccountSnapshotSol = (*self).into();
        <AccountSnapshotSol as SolTypeValue<AccountSnapshotSol>>::stv_abi_encode_packed_to(
            &value, out,
        );
    }

    fn stv_eip712_data_word(&self) -> sails_rs::alloy_sol_types::Word {
        let value: AccountSnapshotSol = (*self).into();
        <AccountSnapshotSol as SolTypeValue<AccountSnapshotSol>>::stv_eip712_data_word(&value)
    }
}

#[cfg(feature = "ethexe")]
impl From<MarketRiskConfigSol> for MarketRiskConfig {
    fn from(value: MarketRiskConfigSol) -> Self {
        Self {
            initial_margin_bps: value.initial_margin_bps,
            maintenance_margin_bps: value.maintenance_margin_bps,
            max_leverage: value.max_leverage,
            funding_interval_blocks: value.funding_interval_blocks,
            liquidation_delay_blocks: value.liquidation_delay_blocks,
            max_funding_velocity_bps: value.max_funding_velocity_bps,
        }
    }
}

#[cfg(feature = "ethexe")]
impl From<MarketRiskConfig> for MarketRiskConfigSol {
    fn from(value: MarketRiskConfig) -> Self {
        Self {
            initial_margin_bps: value.initial_margin_bps,
            maintenance_margin_bps: value.maintenance_margin_bps,
            max_leverage: value.max_leverage,
            funding_interval_blocks: value.funding_interval_blocks,
            liquidation_delay_blocks: value.liquidation_delay_blocks,
            max_funding_velocity_bps: value.max_funding_velocity_bps,
        }
    }
}

#[cfg(feature = "ethexe")]
impl SolValue for MarketRiskConfig {
    type SolType = MarketRiskConfigSol;
}

#[cfg(feature = "ethexe")]
impl SolTypeValue<MarketRiskConfigSol> for MarketRiskConfig {
    fn stv_to_tokens(&self) -> <MarketRiskConfigSol as SolType>::Token<'_> {
        let value: MarketRiskConfigSol = (*self).into();
        <MarketRiskConfigSol as SolTypeValue<MarketRiskConfigSol>>::stv_to_tokens(&value)
    }

    fn stv_abi_encode_packed_to(&self, out: &mut sails_rs::Vec<u8>) {
        let value: MarketRiskConfigSol = (*self).into();
        <MarketRiskConfigSol as SolTypeValue<MarketRiskConfigSol>>::stv_abi_encode_packed_to(
            &value, out,
        );
    }

    fn stv_eip712_data_word(&self) -> sails_rs::alloy_sol_types::Word {
        let value: MarketRiskConfigSol = (*self).into();
        <MarketRiskConfigSol as SolTypeValue<MarketRiskConfigSol>>::stv_eip712_data_word(&value)
    }
}

#[cfg(feature = "ethexe")]
impl From<PositionSol> for Position {
    fn from(value: PositionSol) -> Self {
        Self {
            size: value.size,
            entry_price: value.entry_price,
            margin: value.margin,
            leverage: value.leverage,
            last_funding_rate_bps: value.last_funding_rate_bps,
            opened_at: value.opened_at,
        }
    }
}

#[cfg(feature = "ethexe")]
impl From<Position> for PositionSol {
    fn from(value: Position) -> Self {
        Self {
            size: value.size,
            entry_price: value.entry_price,
            margin: value.margin,
            leverage: value.leverage,
            last_funding_rate_bps: value.last_funding_rate_bps,
            opened_at: value.opened_at,
        }
    }
}

#[cfg(feature = "ethexe")]
impl SolValue for Position {
    type SolType = PositionSol;
}

#[cfg(feature = "ethexe")]
impl SolTypeValue<PositionSol> for Position {
    fn stv_to_tokens(&self) -> <PositionSol as SolType>::Token<'_> {
        let value: PositionSol = self.clone().into();
        <PositionSol as SolTypeValue<PositionSol>>::stv_to_tokens(&value)
    }

    fn stv_abi_encode_packed_to(&self, out: &mut sails_rs::Vec<u8>) {
        let value: PositionSol = self.clone().into();
        <PositionSol as SolTypeValue<PositionSol>>::stv_abi_encode_packed_to(&value, out);
    }

    fn stv_eip712_data_word(&self) -> sails_rs::alloy_sol_types::Word {
        let value: PositionSol = self.clone().into();
        <PositionSol as SolTypeValue<PositionSol>>::stv_eip712_data_word(&value)
    }
}

#[cfg(feature = "ethexe")]
impl From<MarketSnapshotSol> for MarketSnapshot {
    fn from(value: MarketSnapshotSol) -> Self {
        Self {
            mark_price: value.mark_price,
            index_price: value.index_price,
            funding_rate_bps: value.funding_rate_bps,
            cumulative_funding_rate_bps: value.cumulative_funding_rate_bps,
            open_interest_long: value.open_interest_long,
            open_interest_short: value.open_interest_short,
        }
    }
}

#[cfg(feature = "ethexe")]
impl From<MarketSnapshot> for MarketSnapshotSol {
    fn from(value: MarketSnapshot) -> Self {
        Self {
            mark_price: value.mark_price,
            index_price: value.index_price,
            funding_rate_bps: value.funding_rate_bps,
            cumulative_funding_rate_bps: value.cumulative_funding_rate_bps,
            open_interest_long: value.open_interest_long,
            open_interest_short: value.open_interest_short,
        }
    }
}

#[cfg(feature = "ethexe")]
impl SolValue for MarketSnapshot {
    type SolType = MarketSnapshotSol;
}

#[cfg(feature = "ethexe")]
impl SolTypeValue<MarketSnapshotSol> for MarketSnapshot {
    fn stv_to_tokens(&self) -> <MarketSnapshotSol as SolType>::Token<'_> {
        let value: MarketSnapshotSol = (*self).into();
        <MarketSnapshotSol as SolTypeValue<MarketSnapshotSol>>::stv_to_tokens(&value)
    }

    fn stv_abi_encode_packed_to(&self, out: &mut sails_rs::Vec<u8>) {
        let value: MarketSnapshotSol = (*self).into();
        <MarketSnapshotSol as SolTypeValue<MarketSnapshotSol>>::stv_abi_encode_packed_to(
            &value, out,
        );
    }

    fn stv_eip712_data_word(&self) -> sails_rs::alloy_sol_types::Word {
        let value: MarketSnapshotSol = (*self).into();
        <MarketSnapshotSol as SolTypeValue<MarketSnapshotSol>>::stv_eip712_data_word(&value)
    }
}
