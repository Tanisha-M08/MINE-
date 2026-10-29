use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{Pool, PoolError, PRECISION};

/// A reward arrives and moves the pool's reward-per-token accumulator.
/// No staker account is touched; any remaining accounts passed are ignored.
#[derive(Accounts)]
pub struct AddRewards<'info> {
    pub funder: Signer<'info>,
    #[account(mut, seeds = [b"pool"], bump = pool.bump)]
    pub pool: Account<'info, Pool>,
    #[account(address = pool.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = funder)]
    pub funder_tokens: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn add_rewards<'info>(
    ctx: Context<'_, '_, 'info, 'info, AddRewards<'info>>,
    amount: u64,
) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let total_staked = pool.total_staked;
    require!(total_staked > 0, PoolError::NothingStaked);

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.funder_tokens.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.funder.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    // Raise the reward per staked token without touching any staker account
    let addition = (amount as u128)
        .checked_mul(PRECISION)
        .ok_or(PoolError::MathOverflow)?
        / total_staked as u128;

    pool.reward_per_token = pool
        .reward_per_token
        .checked_add(addition)
        .ok_or(PoolError::MathOverflow)?;

    Ok(())
}
