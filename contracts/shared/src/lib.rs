#![cfg_attr(not(test), no_std)]

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

/// Trading fee charged on a traded notional, in basis points.
///
/// `fee_bps` of `0` yields `Some(0)` (fees disabled). Returns `None` only on
/// arithmetic overflow.
pub fn trading_fee(notional: u128, fee_bps: u16) -> Option<u128> {
    notional.checked_mul(fee_bps as u128)?.checked_div(BPS_DIVISOR)
}

/// Liquidation penalty charged on the liquidated notional, in basis points.
/// Routed to the insurance fund. `0` disables the penalty.
pub fn liquidation_penalty(notional: u128, penalty_bps: u16) -> Option<u128> {
    notional
        .checked_mul(penalty_bps as u128)?
        .checked_div(BPS_DIVISOR)
}

/// Size to close in a single liquidation step.
///
/// `fraction_bps` is the share of the position closed per liquidation (`10_000`
/// = the whole position). Values of `0` or `>= 10_000` close the full position;
/// otherwise the closed size is at least one unit and never exceeds the
/// position, so repeated calls progressively wind a position down rather than
/// dumping it all at once.
pub fn liquidation_close_size(full_size: u128, fraction_bps: u16) -> u128 {
    if full_size == 0 {
        return 0;
    }
    if fraction_bps == 0 || fraction_bps as u128 >= BPS_DIVISOR {
        return full_size;
    }
    let portion = full_size.saturating_mul(fraction_bps as u128) / BPS_DIVISOR;
    portion.max(1).min(full_size)
}

/// Funding contribution from open-interest imbalance, in basis points.
///
/// Positive when longs outweigh shorts (longs pay shorts, pulling the book back
/// toward balance and compensating the pool for its directional exposure).
/// `coefficient_bps` scales the imbalance ratio (the funding applied at a fully
/// one-sided book); `0` disables skew funding entirely.
pub fn skew_funding_bps(oi_long: u128, oi_short: u128, coefficient_bps: u16) -> i128 {
    if coefficient_bps == 0 {
        return 0;
    }
    let total = oi_long.saturating_add(oi_short);
    if total == 0 {
        return 0;
    }
    let imbalance = oi_long as i128 - oi_short as i128;
    imbalance
        .saturating_mul(coefficient_bps as i128)
        .checked_div(total as i128)
        .unwrap_or(0)
}

/// Price-move circuit breaker. Returns `true` when `next` is within `max_bps`
/// of `previous`. A `max_bps` of `0` disables the check. Used to reject a price
/// update that jumps further than the configured tolerance from the last
/// accepted price (fat-finger / compromised-relayer protection).
pub fn within_deviation(previous: u128, next: u128, max_bps: u16) -> bool {
    within_price_band(next, previous, max_bps)
}

/// Oracle price-band guard for fills in an oracle-priced market.
///
/// Returns `true` when `mark` is within `max_bps` of `index`. A `max_bps` of `0`
/// disables the check (treated as "no slippage limit"). The trader is protected
/// against opening into a mark price that has dislocated from the index beyond
/// their chosen tolerance. On overflow or a zero index the guard fails closed
/// (returns `false`) so a degenerate oracle state cannot wave a fill through.
pub fn within_price_band(mark: u128, index: u128, max_bps: u16) -> bool {
    if max_bps == 0 {
        return true;
    }
    if index == 0 {
        return false;
    }
    let diff = mark.abs_diff(index);
    match (
        diff.checked_mul(BPS_DIVISOR),
        index.checked_mul(max_bps as u128),
    ) {
        (Some(lhs), Some(rhs)) => lhs <= rhs,
        _ => false,
    }
}

#[cfg(test)]
mod baseline_tests {
    use super::*;

    #[test]
    fn margin_requirement_is_bps_of_notional() {
        // 10% of 1_000 = 100
        assert_eq!(margin_requirement(1_000, 1_000), Some(100));
    }

    #[test]
    fn collateral_for_leverage_divides_notional() {
        assert_eq!(collateral_for_leverage(1_000, 10), Some(100));
        assert_eq!(collateral_for_leverage(1_000, 0), None);
    }

    #[test]
    fn price_band_zero_bps_disables_check() {
        assert!(within_price_band(100, 200, 0));
    }

    #[test]
    fn price_band_accepts_within_tolerance() {
        // 50 bps = 0.5%. index 10_000 -> band +/- 50.
        assert!(within_price_band(10_050, 10_000, 50));
        assert!(within_price_band(9_950, 10_000, 50));
        assert!(within_price_band(10_000, 10_000, 50));
    }

    #[test]
    fn price_band_rejects_outside_tolerance() {
        assert!(!within_price_band(10_051, 10_000, 50));
        assert!(!within_price_band(9_949, 10_000, 50));
    }

    #[test]
    fn price_band_fails_closed_on_zero_index() {
        assert!(!within_price_band(10_000, 0, 50));
    }

    #[test]
    fn trading_fee_is_bps_of_notional() {
        // 10 bps of 1_000_000 = 1_000
        assert_eq!(trading_fee(1_000_000, 10), Some(1_000));
    }

    #[test]
    fn trading_fee_zero_bps_is_zero() {
        assert_eq!(trading_fee(1_000_000, 0), Some(0));
    }

    #[test]
    fn deviation_guard_allows_small_moves() {
        // 500 bps = 5%. prev 10_000 -> allow up to 10_500 / down to 9_500.
        assert!(within_deviation(10_000, 10_500, 500));
        assert!(within_deviation(10_000, 9_500, 500));
    }

    #[test]
    fn deviation_guard_blocks_large_moves() {
        assert!(!within_deviation(10_000, 10_501, 500));
        assert!(!within_deviation(10_000, 9_499, 500));
    }

    #[test]
    fn deviation_guard_zero_bps_disables() {
        assert!(within_deviation(10_000, 50_000, 0));
    }

    #[test]
    fn skew_funding_zero_when_balanced() {
        assert_eq!(skew_funding_bps(1_000, 1_000, 100), 0);
    }

    #[test]
    fn skew_funding_positive_when_longs_dominate() {
        // fully long book -> full coefficient applied
        assert_eq!(skew_funding_bps(1_000, 0, 100), 100);
        // 75/25 split -> imbalance ratio 0.5 -> 50 bps
        assert_eq!(skew_funding_bps(750, 250, 100), 50);
    }

    #[test]
    fn skew_funding_negative_when_shorts_dominate() {
        assert_eq!(skew_funding_bps(0, 1_000, 100), -100);
    }

    #[test]
    fn skew_funding_disabled_and_empty_book() {
        assert_eq!(skew_funding_bps(1_000, 0, 0), 0);
        assert_eq!(skew_funding_bps(0, 0, 100), 0);
    }

    #[test]
    fn liquidation_penalty_is_bps_of_notional() {
        // 100 bps (1%) of 1_000_000 = 10_000
        assert_eq!(liquidation_penalty(1_000_000, 100), Some(10_000));
        assert_eq!(liquidation_penalty(1_000_000, 0), Some(0));
    }

    #[test]
    fn liquidation_close_size_full_when_uncapped() {
        assert_eq!(liquidation_close_size(1_000, 0), 1_000);
        assert_eq!(liquidation_close_size(1_000, 10_000), 1_000);
        assert_eq!(liquidation_close_size(1_000, 20_000), 1_000);
    }

    #[test]
    fn liquidation_close_size_partial() {
        // 2_500 bps = 25%
        assert_eq!(liquidation_close_size(1_000, 2_500), 250);
        // rounds down but never to zero for a non-empty position
        assert_eq!(liquidation_close_size(3, 1), 1);
        assert_eq!(liquidation_close_size(0, 2_500), 0);
    }
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
