use anchor_lang::prelude::*;

use crate::{PoolError, Staker};

pub const PRECISION: u128 = 1_000_000_000_000_000_000; // 10^18

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub total_staked: u64,
    pub reward_per_token: u128,
    pub bump: u8,
}

impl Pool {
    pub fn settle(&self, staker: &mut Staker) -> Result<()> {
        if staker.reward_per_token == 0 && staker.stake == 0 {
            staker.reward_per_token = self.reward_per_token;
            return Ok(());
        }
        let delta = self
            .reward_per_token
            .checked_sub(staker.reward_per_token)
            .ok_or(PoolError::MathOverflow)?;
        if delta > 0 && staker.stake > 0 {
            let earned = (staker.stake as u128)
                .checked_mul(delta)
                .ok_or(PoolError::MathOverflow)?
                / PRECISION;
            staker.pending = staker
                .pending
                .checked_add(u64::try_from(earned).map_err(|_| PoolError::MathOverflow)?)
                .ok_or(PoolError::MathOverflow)?;
        }
        staker.reward_per_token = self.reward_per_token;
        Ok(())
    }
}
