use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;
pub mod state;

pub use error::*;
#[allow(ambiguous_glob_reexports)]
pub use instructions::*;
pub use state::*;

declare_id!("HReKhsVu24hzPjuWzM5Ak5qr8LC1HvtUZdghEikbNA4s");

#[program]
pub mod operator_free {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        bot: Pubkey,
        oracle: Pubkey,
        max_price_age: i64,
    ) -> Result<()> {
        instructions::initialize(ctx, bot, oracle, max_price_age)
    }

    pub fn accrue(ctx: Context<Accrue>, amount: u64) -> Result<()> {
        instructions::accrue(ctx, amount)
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::claim(ctx)
    }

    pub fn set_price(ctx: Context<SetPrice>, price: u64) -> Result<()> {
        instructions::set_price(ctx, price)
    }

    pub fn buy(ctx: Context<Buy>, lamports: u64) -> Result<()> {
        instructions::buy(ctx, lamports)
    }
}
