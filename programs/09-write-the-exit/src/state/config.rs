use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub executor: Pubkey,
    pub mint: Pubkey,
    pub dex_program: Pubkey,
    pub pending_dex: Option<Pubkey>,
    pub dex_change_ready_at: i64,
    pub bump: u8,
}
