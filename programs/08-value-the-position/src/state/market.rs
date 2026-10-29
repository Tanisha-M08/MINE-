use anchor_lang::prelude::*;

use crate::AVERAGE_WINDOW_SECONDS;

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub admin: Pubkey,
    pub collateral_mint: Pubkey,
    pub debt_mint: Pubkey,
    pub collateral_feed: [u8; 32],
    pub debt_feed: [u8; 32],
    pub max_price_age: u64,
    pub borrow_ltv_bps: u16,
    pub liquidation_ltv_bps: u16,
    pub collateral_price_average: u64,
    pub last_update_time: i64,
    pub bump: u8,
}

impl Market {
    pub fn update_collateral_price_average(&mut self, current_price: u64, current_time: i64) {
        if self.last_update_time == 0 || self.collateral_price_average == 0 {
            self.collateral_price_average = current_price;
            self.last_update_time = current_time;
            return;
        }

        let elapsed = current_time.saturating_sub(self.last_update_time);
        if elapsed <= 0 {
            return;
        }

        let dt = elapsed.min(AVERAGE_WINDOW_SECONDS) as u64;
        let w = AVERAGE_WINDOW_SECONDS as u64;

        let prev = self.collateral_price_average as u128;
        let curr = current_price as u128;
        let new_avg = (prev * (w - dt) as u128 + curr * dt as u128) / (w as u128);

        self.collateral_price_average = new_avg as u64;
        self.last_update_time = current_time;
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MarketParams {
    pub collateral_feed: [u8; 32],
    pub debt_feed: [u8; 32],
    pub max_price_age: u64,
    pub borrow_ltv_bps: u16,
    pub liquidation_ltv_bps: u16,
}
