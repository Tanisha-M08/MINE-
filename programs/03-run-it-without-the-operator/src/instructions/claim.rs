use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{Config, RewardsError, User};

/// The admin credits a user with a reward. This is where rewards come from; it stays.
/// No payout occurs here—tokens only move when `claim` is executed.
#[derive(Accounts)]
pub struct Accrue<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    /// CHECK: the user the reward is credited to; only their key is needed.
    pub owner: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + User::INIT_SPACE,
        seeds = [b"user", owner.key().as_ref()],
        bump,
    )]
    pub user: Account<'info, User>,
    pub system_program: Program<'info, System>,
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

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        seeds = [b"vault"],
        bump,
        token::mint = mint,
        token::authority = config,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

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
