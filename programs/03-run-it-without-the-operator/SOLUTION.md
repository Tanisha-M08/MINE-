# Solution

## Why the caller does not matter

In `claim`, the recipient of the reward is strictly bound to the `User` account PDA (`seeds = [b"user", user.owner.as_ref()]`), with Anchor enforcing that `user_tokens` belongs to `user.owner` (`token::authority = user.owner, token::mint = mint`).

Because the beneficiary is anchored to the canonical on-chain `User` state established during `accrue`, any arbitrary signer (`caller: Signer<'info>`) can submit the claim transaction without being able to redirect or siphon the user's funds. The caller only receives a small, deterministic executor fee, while the user's net reward is transferred directly from the program vault to `user_tokens`.

If the reward went to the caller instead of the user:
1. Any third-party executor, searcher, or MEV bot could trigger claims on behalf of arbitrary users and steal all accrued rewards.
2. The mechanism would collapse from a user reward distribution program into an adversarial "first-to-claim steals everything" race.
3. Separating the *executor* (who submits the transaction) from the *beneficiary* (who owns the reward) ensures the outcome is deterministic, immutable, and invariant to who triggers the transaction.

## The caller's fee

- **Sizing:** The fee is sized at 1% (100 basis points, `pending * 100 / 10_000`) of the pending reward.
- **What it covers:**
  1. Solana network transaction fees (base fee of 5,000 lamports plus priority fees).
  2. Node/RPC operational expenses for automated crank bots.
  3. A predictable economic profit margin so that decentralized bots are economically incentivized to run and maintain protocol liveness. (At a market price of ~0.01 SOL per token, 1% of a 10-token reward is 0.1 tokens = ~100,000 lamports, yielding a 20x return over the standard transaction fee).
- **Capping:**
  - The fee is capped at 1 whole token (`1_000_000` base units with 6 decimals) via `.min(MAX_CALLER_FEE)`.
  - Capping prevents disproportionate fee extraction on large rewards, ensuring the executor is paid for the service of transaction relay rather than capturing unfair protocol rent.
  - If a user claims for themselves (`caller_tokens.key() == user_tokens.key()`), fee deduction is bypassed and 100% of the pending reward is transferred to the user.

## The price

- **Who brings the price:**
  Whoever needs to execute a trade or update market state (such as the buyer or an untrusted relayer) brings the oracle-signed price update directly within the transaction. No dedicated team background bot is required.
- **What the program checks:**
  1. **Instructions Sysvar Authentication:** Enforces that `instructions` strictly matches `anchor_lang::solana_program::sysvar::instructions::ID` (`Sysvar1nstructions1111111111111111111111111`).
  2. **Preceding Precompile Invocation:** Checks `load_current_index_checked` and inspects the instruction immediately preceding `set_price` (`current_index - 1`).
  3. **Ed25519 Structure:** Verifies `ix.program_id == ed25519_program::ID`, checks for single-signature header layout (`len >= 16`, `d[0] == 1`), verifies relative offsets (`0xffff`), and validates buffer slices.
  4. **Oracle Authenticity:** Compares the recovered signer against the trusted public key stored on-chain in `config.oracle` (`require_keys_eq!(signed.pubkey, config.oracle)`).
  5. **Payload Integrity:** Extracts `price: u64` and `timestamp: i64` from the 16-byte signed payload, ensures `price == signed_price` and `price > 0`.
  6. **Freshness:** Asserts `signed_time <= now + 5 && now - signed_time <= config.max_price_age`.
- **When the update is too old:**
  If the timestamp is older than `config.max_price_age` (60 seconds), the instruction aborts immediately with `RewardsError::StalePrice`. The price is rejected and cannot be stored or traded on, preventing stale price arbitrage.

## What stays with the admin

- **Which instructions still need the admin's key:**
  1. `initialize`: One-time bootstrap to configure protocol parameters (`oracle`, `mint`, `max_price_age`) and initialize the vault.
  2. `accrue`: Allocating reward balances to individual users.
- **Why that is acceptable:**
  - `accrue` represents the business and governance decision of *originating* rewards (e.g. staking yields, protocol incentives). Deciding which users have earned rewards is fundamentally an administrative/governance role, not a mechanical operational task.
  - Unlike the legacy `pay_reward` or `set_price`, `accrue` does not stand in the execution path of existing funds or trades. If the admin goes offline or shuts down their servers indefinitely:
    - Users and third-party cranks can still permissionlessly claim all accrued rewards at any time.
    - Traders can still permissionlessly update prices and buy tokens from the vault via pull oracle signatures.
  - The day-to-day operation of the protocol continues indefinitely without any operator running.
