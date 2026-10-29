use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod instructions;
pub mod pricing;
pub mod state;

pub use constants::*;
pub use error::*;
#[allow(ambiguous_glob_reexports)]
pub use instructions::*;
pub use state::*;

declare_id!("5ya2NoKrWxiULXTRktq1oXCXpYh7sxSvJ1dGKhJ8MHWK");

#[program]
pub mod position_value {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, params: MarketParams) -> Result<()> {
        instructions::initialize(ctx, params)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit(ctx, amount)
    }

    pub fn borrow(ctx: Context<Borrow>, amount: u64) -> Result<()> {
        instructions::borrow(ctx, amount)
    }

    pub fn liquidate(ctx: Context<Liquidate>) -> Result<()> {
        instructions::liquidate(ctx)
    }
}
