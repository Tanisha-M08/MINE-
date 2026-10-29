use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::{MarketError, PRICE_DECIMALS};

pub struct Band {
    pub low: u64,
    pub mid: u64,
    pub high: u64,
}

pub fn read_band(
    update: &PriceUpdateV2,
    feed_id: &[u8; 32],
    max_age: u64,
    clock: &Clock,
) -> Result<Band> {
    let price = update
        .get_price_no_older_than(clock, max_age, feed_id)
        .map_err(|e| match e {
            pyth_solana_receiver_sdk::error::GetPriceError::PriceTooOld => {
                error!(MarketError::StalePrice)
            }
            _ => error!(MarketError::InvalidPrice),
        })?;
    require!(price.price > 0, MarketError::InvalidPrice);
    let price_u64 = price.price as u64;
    let low_raw = price_u64.saturating_sub(price.conf);
    let mid_raw = price_u64;
    let high_raw = price_u64
        .checked_add(price.conf)
        .ok_or(MarketError::MathOverflow)?;

    let low = scale(low_raw, price.exponent)?;
    let mid = scale(mid_raw, price.exponent)?;
    let high = scale(high_raw, price.exponent)?;

    Ok(Band { low, mid, high })
}

pub fn value(amount: u64, price: u64, decimals: u8) -> Result<u128> {
    Ok((amount as u128)
        .checked_mul(price as u128)
        .ok_or(MarketError::MathOverflow)?
        / 10u128.pow(decimals as u32))
}

pub fn scale(value: u64, exponent: i32) -> Result<u64> {
    let target = -(PRICE_DECIMALS as i32);
    let value = value as u128;
    let scaled = if exponent < target {
        value / 10u128.pow((target - exponent) as u32)
    } else {
        value
            .checked_mul(10u128.pow((exponent - target) as u32))
            .ok_or(MarketError::MathOverflow)?
    };
    u64::try_from(scaled).map_err(|_| MarketError::MathOverflow.into())
}
