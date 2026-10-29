use anchor_lang::prelude::*;

pub mod ed25519;
pub mod error;
pub mod instructions;
pub mod state;

pub use ed25519::*;
pub use error::*;
#[allow(ambiguous_glob_reexports)]
pub use instructions::*;
pub use state::*;

declare_id!("2egvSswNkKRYTDEcK9hKkN1Wz5iSDCLQCijY1XjJ6aVY");

#[program]
pub mod total_claims {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, oracle: Pubkey) -> Result<()> {
        instructions::initialize(ctx, oracle)
    }

    pub fn register_device(ctx: Context<RegisterDevice>) -> Result<()> {
        instructions::register_device(ctx)
    }

    pub fn claim(ctx: Context<Claim>, total: u64) -> Result<()> {
        instructions::claim(ctx, total)
    }
}
