use anchor_lang::prelude::*;

use crate::{Config, RoundError, DEX_CHANGE_DELAY};

#[derive(Accounts)]
pub struct ProposeDex<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

pub fn propose_dex(ctx: Context<ProposeDex>, new_dex: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.pending_dex = Some(new_dex);
    config.dex_change_ready_at = Clock::get()?.unix_timestamp + DEX_CHANGE_DELAY;
    Ok(())
}

#[derive(Accounts)]
pub struct ApplyDex<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

pub fn apply_dex(ctx: Context<ApplyDex>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let pending = config.pending_dex.ok_or(RoundError::NoPendingDex)?;
    require!(
        Clock::get()?.unix_timestamp >= config.dex_change_ready_at,
        RoundError::DexChangeNotReady
    );
    config.dex_program = pending;
    config.pending_dex = None;
    config.dex_change_ready_at = 0;
    Ok(())
}

#[derive(Accounts)]
pub struct CancelDexProposal<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

pub fn cancel_dex_proposal(ctx: Context<CancelDexProposal>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(config.pending_dex.is_some(), RoundError::NoPendingDex);
    config.pending_dex = None;
    config.dex_change_ready_at = 0;
    Ok(())
}
