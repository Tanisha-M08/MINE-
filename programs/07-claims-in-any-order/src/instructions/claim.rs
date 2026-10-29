use anchor_lang::prelude::*;
use anchor_lang::solana_program::ed25519_program;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{ClaimError, Config, Device};

/// What an Ed25519 instruction verified: the key that signed and the message.
pub struct Ed25519Signed {
    pub pubkey: Pubkey,
    pub message: Vec<u8>,
}

/// Parses a single-signature instruction built for the Ed25519 program (the layout
/// `Ed25519Program.createInstructionWithPrivateKey` produces): a 16-byte header with
/// offsets, then the public key, the signature and the message, all inside this instruction.
pub fn parse_ed25519(ix: &Instruction) -> Result<Ed25519Signed> {
    require_keys_eq!(ix.program_id, ed25519_program::ID, ClaimError::NotEd25519);
    let d = &ix.data;
    require!(d.len() >= 16 && d[0] == 1, ClaimError::MalformedEd25519);
    let u16_at = |i: usize| u16::from_le_bytes([d[i], d[i + 1]]) as usize;
    let (sig_ix, pk_off, pk_ix) = (u16_at(4), u16_at(6), u16_at(8));
    let (msg_off, msg_size, msg_ix) = (u16_at(10), u16_at(12), u16_at(14));
    require!(
        sig_ix == 0xffff && pk_ix == 0xffff && msg_ix == 0xffff,
        ClaimError::MalformedEd25519
    );
    require!(
        d.len() >= pk_off + 32 && d.len() >= msg_off + msg_size,
        ClaimError::MalformedEd25519
    );
    let mut pubkey = [0u8; 32];
    pubkey.copy_from_slice(&d[pk_off..pk_off + 32]);
    Ok(Ed25519Signed {
        pubkey: Pubkey::from(pubkey),
        message: d[msg_off..msg_off + msg_size].to_vec(),
    })
}

/// Pays the difference between the signed total and the amount already paid.
/// Anyone can bring a signed total from the oracle.
#[derive(Accounts)]
pub struct Claim<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"device", device.owner.as_ref()], bump = device.bump)]
    pub device: Account<'info, Device>,
    #[account(address = config.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = device.owner)]
    pub owner_tokens: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: the instructions sysvar; its address is verified before reading.
    #[account(address = ix_sysvar::ID @ ClaimError::NotEd25519)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// The message the oracle signs for a claim: device (32 bytes), total (8 bytes LE).
pub fn claim_message(device: &Pubkey, total: u64) -> Vec<u8> {
    let mut message = Vec::with_capacity(40);
    message.extend_from_slice(device.as_ref());
    message.extend_from_slice(&total.to_le_bytes());
    message
}

pub fn claim(ctx: Context<Claim>, total: u64) -> Result<()> {
    // 1. Verify instructions sysvar address before anything is read from it
    require_keys_eq!(
        ctx.accounts.instructions.key(),
        ix_sysvar::ID,
        ClaimError::NotEd25519
    );

    // 2. Load and parse the preceding Ed25519 signature check
    let current_index =
        ix_sysvar::load_current_index_checked(&ctx.accounts.instructions.to_account_info())
            .map_err(|_| ClaimError::NotEd25519)?;
    require!(current_index > 0, ClaimError::NotEd25519);
    let signature_check = ix_sysvar::load_instruction_at_checked(
        (current_index - 1) as usize,
        &ctx.accounts.instructions.to_account_info(),
    )
    .map_err(|_| ClaimError::NotEd25519)?;
    let signed = parse_ed25519(&signature_check)?;

    // 3. Verify oracle signer against stored config.oracle
    require_keys_eq!(
        signed.pubkey,
        ctx.accounts.config.oracle,
        ClaimError::WrongSigner
    );

    // 4. Verify message matches this device and signed total
    let expected = claim_message(&ctx.accounts.device.key(), total);
    require!(signed.message == expected, ClaimError::MessageMismatch);

    // 5. Compare with current device state:
    // If total > paid, pay the difference and move paid up to total.
    // If total <= paid, changes nothing. Paid amount never goes down.
    let device = &mut ctx.accounts.device;
    if total > device.paid {
        let delta = total
            .checked_sub(device.paid)
            .ok_or(ClaimError::MathOverflow)?;
        device.paid = total;

        let seeds: &[&[u8]] = &[b"config", &[ctx.accounts.config.bump]];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.owner_tokens.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            delta,
            ctx.accounts.mint.decimals,
        )?;
    }

    Ok(())
}
