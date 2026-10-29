use anchor_lang::prelude::*;

use crate::{Config, MultisigError, Proposal};

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"proposal", proposal.id.to_le_bytes().as_ref()],
        bump = proposal.bump,
        close = proposer,
    )]
    pub proposal: Account<'info, Proposal>,
    /// CHECK: the proposer who paid for the proposal account and receives the rent refund.
    #[account(mut, address = proposal.proposer)]
    pub proposer: UncheckedAccount<'info>,
}

pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
    let proposal = &ctx.accounts.proposal;
    require!(!proposal.executed, MultisigError::AlreadyExecuted);

    let now = Clock::get()?.unix_timestamp;
    let is_expired = now >= proposal.expires_at;
    let is_authorized = ctx.accounts.config.is_member(&ctx.accounts.caller.key())
        || ctx.accounts.caller.key() == proposal.proposer;

    require!(is_expired || is_authorized, MultisigError::NotAMember);

    Ok(())
}
