use anchor_lang::prelude::*;

#[error_code]
pub enum MarketError {
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("The borrow limit must be below the liquidation limit")]
    InvalidParams,
    #[msg("The price is too old")]
    StalePrice,
    #[msg("The price is invalid")]
    InvalidPrice,
    #[msg("The borrow limit would be exceeded")]
    BorrowLimitExceeded,
    #[msg("The position is healthy and cannot be liquidated")]
    PositionHealthy,
    #[msg("The position has no debt to liquidate")]
    NothingToLiquidate,
}
