use anchor_lang::prelude::*;

pub const DEX_PROGRAM_ID: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

/// Delay after round deadline before players can refund un-settled stakes (1 hour).
pub const REFUND_DELAY: i64 = 3600;

/// Timelock delay required between proposing a new DEX venue and applying it (3 days).
pub const DEX_CHANGE_DELAY: i64 = 259_200;
