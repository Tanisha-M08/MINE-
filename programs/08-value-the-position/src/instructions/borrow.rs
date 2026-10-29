use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::pricing::{read_band, value};
use crate::{Market, MarketError, Position, BPS};

#[derive(Accounts)]
pub struct Borrow<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"market"], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [b"position", owner.key().as_ref()],
        bump = position.bump,
        has_one = owner,
    )]
    pub position: Account<'info, Position>,
    #[account(address = market.collateral_mint)]
    pub collateral_mint: Account<'info, Mint>,
    #[account(address = market.debt_mint)]
    pub debt_mint: Account<'info, Mint>,
    #[account(mut, token::mint = debt_mint)]
    pub owner_debt: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"debt_vault"], bump)]
    pub debt_vault: Account<'info, TokenAccount>,
    pub collateral_price: Box<Account<'info, PriceUpdateV2>>,
    pub debt_price: Box<Account<'info, PriceUpdateV2>>,
    pub token_program: Program<'info, Token>,
}

pub fn borrow(ctx: Context<Borrow>, amount: u64) -> Result<()> {
    let clock = Clock::get()?;
    let collateral_band = read_band(
        &ctx.accounts.collateral_price,
        &ctx.accounts.market.collateral_feed,
        ctx.accounts.market.max_price_age,
        &clock,
    )?;
    let debt_band = read_band(
        &ctx.accounts.debt_price,
        &ctx.accounts.market.debt_feed,
        ctx.accounts.market.max_price_age,
        &clock,
    )?;

    // Update market's moving average of collateral price
    ctx.accounts
        .market
        .update_collateral_price_average(collateral_band.mid, clock.unix_timestamp);

    let new_debt = ctx
        .accounts
        .position
        .debt
        .checked_add(amount)
        .ok_or(MarketError::MathOverflow)?;

    // Value position at its worst:
    // Collateral at the low end of its band, capped by the market's own average:
    let effective_collateral_price = collateral_band
        .low
        .min(ctx.accounts.market.collateral_price_average);
    let collateral_val = value(
        ctx.accounts.position.collateral,
        effective_collateral_price,
        ctx.accounts.collateral_mint.decimals,
    )?;
    // Debt at the high end of its band:
    let debt_val = value(
        new_debt,
        debt_band.high,
        ctx.accounts.debt_mint.decimals,
    )?;

    // Check borrow LTV: debt_val * BPS <= collateral_val * borrow_ltv_bps
    let max_allowed_debt_val = collateral_val
        .checked_mul(ctx.accounts.market.borrow_ltv_bps as u128)
        .ok_or(MarketError::MathOverflow)?;
    let actual_debt_val_scaled = debt_val
        .checked_mul(BPS as u128)
        .ok_or(MarketError::MathOverflow)?;

    require!(
        actual_debt_val_scaled <= max_allowed_debt_val,
        MarketError::BorrowLimitExceeded
    );

    ctx.accounts.position.debt = new_debt;

    let seeds: &[&[u8]] = &[b"market", &[ctx.accounts.market.bump]];
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.debt_vault.to_account_info(),
                mint: ctx.accounts.debt_mint.to_account_info(),
                to: ctx.accounts.owner_debt.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.debt_mint.decimals,
    )
}
