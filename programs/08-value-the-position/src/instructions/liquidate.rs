use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::pricing::{read_band, value};
use crate::{Market, MarketError, Position, BPS};

#[derive(Accounts)]
pub struct Liquidate<'info> {
    pub liquidator: Signer<'info>,
    #[account(mut, seeds = [b"market"], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"position", position.owner.as_ref()], bump = position.bump)]
    pub position: Account<'info, Position>,
    #[account(address = market.collateral_mint)]
    pub collateral_mint: Account<'info, Mint>,
    #[account(address = market.debt_mint)]
    pub debt_mint: Account<'info, Mint>,
    #[account(mut, token::mint = debt_mint, token::authority = liquidator)]
    pub liquidator_debt: Account<'info, TokenAccount>,
    #[account(mut, token::mint = collateral_mint)]
    pub liquidator_collateral: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"debt_vault"], bump)]
    pub debt_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"collateral_vault"], bump)]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    pub collateral_price: Box<Account<'info, PriceUpdateV2>>,
    pub debt_price: Box<Account<'info, PriceUpdateV2>>,
    pub token_program: Program<'info, Token>,
}

pub fn liquidate(ctx: Context<Liquidate>) -> Result<()> {
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

    let debt_amount = ctx.accounts.position.debt;
    let collateral_amount = ctx.accounts.position.collateral;
    require!(debt_amount > 0, MarketError::NothingToLiquidate);

    // Value position at its worst using spot prices directly (NOT the average):
    // Collateral at low end of band, Debt at high end of band.
    let collateral_val = value(
        collateral_amount,
        collateral_band.low,
        ctx.accounts.collateral_mint.decimals,
    )?;
    let debt_val = value(
        debt_amount,
        debt_band.high,
        ctx.accounts.debt_mint.decimals,
    )?;

    // Liquidation is allowed ONLY above liquidation_ltv_bps:
    // debt_val * BPS > collateral_val * liquidation_ltv_bps
    let liquidation_threshold_val = collateral_val
        .checked_mul(ctx.accounts.market.liquidation_ltv_bps as u128)
        .ok_or(MarketError::MathOverflow)?;
    let actual_debt_val_scaled = debt_val
        .checked_mul(BPS as u128)
        .ok_or(MarketError::MathOverflow)?;

    require!(
        actual_debt_val_scaled > liquidation_threshold_val,
        MarketError::PositionHealthy
    );

    // Repay entire debt from liquidator into debt_vault
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.liquidator_debt.to_account_info(),
                mint: ctx.accounts.debt_mint.to_account_info(),
                to: ctx.accounts.debt_vault.to_account_info(),
                authority: ctx.accounts.liquidator.to_account_info(),
            },
        ),
        debt_amount,
        ctx.accounts.debt_mint.decimals,
    )?;

    // Transfer all collateral from collateral_vault to liquidator_collateral
    let seeds: &[&[u8]] = &[b"market", &[ctx.accounts.market.bump]];
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.collateral_vault.to_account_info(),
                mint: ctx.accounts.collateral_mint.to_account_info(),
                to: ctx.accounts.liquidator_collateral.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            &[seeds],
        ),
        collateral_amount,
        ctx.accounts.collateral_mint.decimals,
    )?;

    ctx.accounts.position.debt = 0;
    ctx.accounts.position.collateral = 0;

    Ok(())
}
