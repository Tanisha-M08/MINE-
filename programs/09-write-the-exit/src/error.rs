use anchor_lang::prelude::*;

#[error_code]
pub enum RoundError {
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("The round is closed for new entries")]
    RoundClosed,
    #[msg("The round has not ended yet")]
    RoundNotEnded,
    #[msg("The round is already settled")]
    AlreadySettled,
    #[msg("The swap returned less than the minimum")]
    SlippageExceeded,
    #[msg("The settlement window has expired")]
    SettlementExpired,
    #[msg("The refund window has not opened yet")]
    RefundTooEarly,
    #[msg("Nothing to refund")]
    NothingToRefund,
    #[msg("No pending DEX change")]
    NoPendingDex,
    #[msg("The DEX change timelock has not expired yet")]
    DexChangeNotReady,
}
