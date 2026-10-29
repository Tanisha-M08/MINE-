use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{Config, RewardsError, User};

pub const CALLER_FEE_BPS: u64 = 100; // 1%
pub const MAX_CALLER_FEE: u64 = 1_000_000; // 1 token (assuming 6 decimals)

/// Anyone can claim rewards for any user.
/// The reward goes to the user's token account, and the caller keeps a small fee.
#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"user", user.owner.as_ref()], bump = user.bump)]
    pub user: Account<'info, User>,
    #[account(address = config.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = user.owner)]
    pub user_tokens: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = caller)]
    pub caller_tokens: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn claim(ctx: Context<Claim>) -> Result<()> {
    let pending = ctx.accounts.user.pending;
    require!(pending > 0, RewardsError::NothingToPay);

    // Prevent double claiming: reset pending immediately
    ctx.accounts.user.pending = 0;

    let seeds: &[&[u8]] = &[b"config", &[ctx.accounts.config.bump]];

    // If caller is claiming for themselves, give full reward without deducting fee
    if ctx.accounts.caller_tokens.key() == ctx.accounts.user_tokens.key() {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.user_tokens.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            pending,
            ctx.accounts.mint.decimals,
        )?;
    } else {
        // Size the caller fee: 1% of pending, capped at 1 token
        let fee = (pending
            .checked_mul(CALLER_FEE_BPS)
            .ok_or(RewardsError::MathOverflow)?
            / 10_000)
            .min(MAX_CALLER_FEE);
        let user_amount = pending.checked_sub(fee).ok_or(RewardsError::MathOverflow)?;

        if user_amount > 0 {
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.user_tokens.to_account_info(),
                        authority: ctx.accounts.config.to_account_info(),
                    },
                    &[seeds],
                ),
                user_amount,
                ctx.accounts.mint.decimals,
            )?;
        }

        if fee > 0 {
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.caller_tokens.to_account_info(),
                        authority: ctx.accounts.config.to_account_info(),
                    },
                    &[seeds],
                ),
                fee,
                ctx.accounts.mint.decimals,
            )?;
        }
    }

    Ok(())
}
