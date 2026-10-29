use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// The oracle that signs prices off-chain.
    pub oracle: Pubkey,
    pub mint: Pubkey,
    /// Lamports per whole token.
    pub price: u64,
    pub price_time: i64,
    pub max_price_age: i64,
    pub bump: u8,
}
