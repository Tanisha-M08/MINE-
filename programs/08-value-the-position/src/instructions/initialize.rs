use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{Market, MarketError, MarketParams, BPS};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Market::INIT_SPACE, seeds = [b"market"], bump)]
    pub market: Account<'info, Market>,
    pub collateral_mint: Account<'info, Mint>,
    pub debt_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        seeds = [b"collateral_vault"],
        bump,
        token::mint = collateral_mint,
        token::authority = market,
    )]
    pub collateral_vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = admin,
        seeds = [b"debt_vault"],
        bump,
        token::mint = debt_mint,
        token::authority = market,
    )]
    pub debt_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn initialize(ctx: Context<Initialize>, params: MarketParams) -> Result<()> {
    require!(
        params.borrow_ltv_bps < params.liquidation_ltv_bps
            && (params.liquidation_ltv_bps as u64) < BPS,
        MarketError::InvalidParams
    );
    ctx.accounts.market.set_inner(Market {
        admin: ctx.accounts.admin.key(),
        collateral_mint: ctx.accounts.collateral_mint.key(),
        debt_mint: ctx.accounts.debt_mint.key(),
        collateral_feed: params.collateral_feed,
        debt_feed: params.debt_feed,
        max_price_age: params.max_price_age,
        borrow_ltv_bps: params.borrow_ltv_bps,
        liquidation_ltv_bps: params.liquidation_ltv_bps,
        collateral_price_average: 0,
        last_update_time: 0,
        bump: ctx.bumps.market,
    });
    Ok(())
}
