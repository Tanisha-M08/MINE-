use anchor_lang::prelude::*;

#[error_code]
pub enum RewardsError {
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Nothing to pay")]
    NothingToPay,
    #[msg("The price is too old to trade on")]
    StalePrice,
    #[msg("The instruction before this one is not an Ed25519 signature check")]
    NotEd25519,
    #[msg("The Ed25519 instruction has an unexpected layout")]
    MalformedEd25519,
    #[msg("The instructions account is not the real instructions sysvar")]
    WrongInstructionsSysvar,
    #[msg("The signer is not the configured oracle")]
    KeyNotAllowed,
    #[msg("The price cannot be zero")]
    InvalidPrice,
    #[msg("Price mismatch")]
    PriceMismatch,
    #[msg("The instructions account has an unexpected layout")]
    MalformedSysvar,
}
