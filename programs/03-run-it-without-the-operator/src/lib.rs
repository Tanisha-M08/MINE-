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

    pub fn initialize(ctx: Context<Initialize>, oracle: Pubkey, max_price_age: i64) -> Result<()> {
        ctx.accounts.config.set_inner(Config {
            admin: ctx.accounts.admin.key(),
            oracle,
            mint: ctx.accounts.mint.key(),
            price: 0,
            price_time: 0,
            max_price_age,
            bump: ctx.bumps.config,
        });
        Ok(())
    }

    pub fn accrue(ctx: Context<Accrue>, amount: u64) -> Result<()> {
        let user = &mut ctx.accounts.user;
        user.owner = ctx.accounts.owner.key();
        user.bump = ctx.bumps.user;
        user.pending = user
            .pending
            .checked_add(amount)
            .ok_or(RewardsError::MathOverflow)?;
        Ok(())
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
