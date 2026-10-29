use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{Config, Entry, Round, RoundError, REFUND_DELAY};

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"round", round.id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    #[account(
        mut,
        seeds = [b"entry", round.key().as_ref(), player.key().as_ref()],
        bump = entry.bump,
        has_one = round,
        has_one = player,
    )]
    pub entry: Account<'info, Entry>,
    #[account(address = config.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = player)]
    pub player_tokens: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn refund(ctx: Context<Refund>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(!round.settled, RoundError::AlreadySettled);
    require!(
        Clock::get()?.unix_timestamp >= round.deadline + REFUND_DELAY,
        RoundError::RefundTooEarly
    );
    let amount = ctx.accounts.entry.amount;
    require!(amount > 0, RoundError::NothingToRefund);

    ctx.accounts.entry.amount = 0;
    round.pot = round
        .pot
        .checked_sub(amount)
        .ok_or(RoundError::MathOverflow)?;

    let seeds: &[&[u8]] = &[b"config", &[ctx.accounts.config.bump]];
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.player_tokens.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )
}
