use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Device {
    pub owner: Pubkey,
    /// The total rewards paid to the device's owner so far.
    pub paid: u64,
    pub bump: u8,
}
