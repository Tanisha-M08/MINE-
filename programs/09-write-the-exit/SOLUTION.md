# Solution

## Dependency 1: the ephemeral rollup

**Would the product make sense without it?**
Yes. The core game product is an escrowed pot game: players deposit stakes into a vault, the game determines a winner, and the pot is transferred to that winner. The economic rules (escrowing funds, accounting for player entries, and distributing payouts) do not inherently depend on an external rollup. If the rollup is removed, game rounds can run on-chain through a turn-based state machine, commit-reveal rounds, or peer-to-peer state channels. Even with the rollup retained for move execution, the product must make sense without it by providing an on-chain escape hatch so player funds are never permanently locked when the rollup halts.

**Should the rounds run on the rollup at all?**
Yes, if the game requires high-frequency, sub-second multiplayer state transitions. The specific Solana limit that justifies running moves on an ephemeral rollup is the **per-account write-lock compute limit (12M CU per block)** and write-lock serialization:
- On Solana, Sealevel can execute non-conflicting transactions in parallel across cores, but transactions modifying the same account (the `Round` account) must execute serially.
- Solana enforces a strict ceiling of **12,000,000 Compute Units per write-locked account per 400ms block** to prevent account starvation.
- In a fast-paced multiplayer game with dozens of players submitting continuous moves, writing every micro-move directly to the `Round` account quickly saturates the 12M CU limit and causes severe write-lock contention, transaction queueing, and dropped transactions.
- Running intermediate game moves on an ephemeral rollup eliminates this limit entirely: moves execute off-chain in memory with zero Solana account contention, and only a single settlement transaction touches Solana when the round ends.
*(Conversely, if the game is simple, low-frequency, or turn-based with few moves, it would consume minimal CU and should run directly on Solana without introducing an off-chain trust assumption).*

**The exit:**
- **What triggers it**: The expiration of the rollup settlement window without a settlement: `Clock::get().unix_timestamp >= round.deadline + REFUND_DELAY` (1 hour after entry deadline) while `!round.settled`.
- **Who can trigger it**: Any player who joined the round can call `refund` to withdraw their own deposited stake.
- **How long it takes**: Exactly `REFUND_DELAY` (1 hour / 3,600 seconds) after the round deadline. Once the delay has passed, the refund transaction executes immediately.
- **Where the players' funds are while it happens**: The funds remain safe on Solana inside the program's vault token account (`["vault"]` PDA). At no point do tokens leave Solana or enter the rollup's custody; only the final settlement CPI transfers funds.

## Dependency 2: the external DEX

**Would the product make sense without it?**
Yes. The game's native economy operates on the game token (`config.mint`). Joining with the native token via `join` is the core functionality. `join_with_swap` is an optional UX convenience allowing players to swap secondary tokens into the game token in the same transaction. If the DEX is shut down or exploited, players can simply swap tokens on any external DEX independently and deposit via `join`.

**The exit:**
- **What triggers it**: The admin calls `propose_dex(new_dex)` when the swap venue needs replacement (e.g. migration to a new DEX or deprecation of the old one).
- **Who can trigger it**: The admin authority calls `propose_dex(new_dex)` to queue a proposed venue and start the timelock. After the timelock expires, the admin calls `apply_dex()` to activate it (or `cancel_dex_proposal()` to abort).
- **How long it takes**: `DEX_CHANGE_DELAY` (3 days / 259,200 seconds) between proposal and activation.

**If the key were stolen:**
- **What could someone do with this exit**: An attacker with the admin key could propose a malicious contract as the DEX program (e.g., a honeypot or drainer that steals tokens approved by users during CPI in `join_with_swap`).
- **What limits the damage**:
  1. The 3-day timelock (`DEX_CHANGE_DELAY`) guarantees the change cannot take effect immediately.
  2. The proposed address is published openly on-chain in `config.pending_dex`, visible to monitoring services, security bots, and players.
  3. Players have 72 hours to notice the malicious proposal, stop using `join_with_swap`, swap through trusted venues off-chain, and continue using `join` or exit their positions.
  4. Funds already deposited in the game vault cannot be drained by the DEX program because `vault` tokens are only transferred by `settle` or `refund`, never by `join_with_swap`.

## Dependency 3: the upgrade authority

**Would the product make sense without it?**
Yes. An audited, feature-complete smart contract can and should be immutable. By revoking the upgrade authority (`set_upgrade_authority(None)`), the program bytecode becomes permanent and un-tamperable. If new features or game variants are developed, they can be deployed as separate programs with voluntary user migration.

**The exit:**
- **What you would change about who holds the key and how a change takes effect**:
  1. Transfer the upgrade authority away from the 2-of-3 third-party multisig to an on-chain DAO/governance contract (such as a Squads multisig) with a mandatory **timelock** (e.g., 7 or 14 days).
  2. Require any proposed bytecode buffer upgrade to be published and verified on-chain throughout the timelock period before execution.
  3. Once the protocol reaches maturity and stability, permanently revoke the upgrade authority by setting it to `None`, making the program strictly immutable.

**If the key were stolen:**
- **What could someone do with it today**:
  With 2-of-3 signers and no timelock, an attacker who compromises two keys or the third-party service can immediately invoke `bpf_loader_upgradeable::upgrade` to replace the program bytecode with malicious code. The attacker could instantly drain 100% of the funds in the vault with zero delay, zero warning, and zero recourse for players.

## What you implemented

### Instructions added
1. `refund(ctx)`: In `src/instructions/refund.rs`. Allows a player to reclaim their deposited stake when a round is not settled by `round.deadline + REFUND_DELAY`. Decrements `round.pot` and resets `entry.amount = 0`.
2. `propose_dex(ctx, new_dex)`: In `src/instructions/change_dex.rs`. Admin proposes a new DEX program address and sets `config.dex_change_ready_at = now + DEX_CHANGE_DELAY`.
3. `apply_dex(ctx)`: In `src/instructions/change_dex.rs`. Admin activates the proposed DEX program after `Clock::now >= config.dex_change_ready_at`.
4. `cancel_dex_proposal(ctx)`: In `src/instructions/change_dex.rs`. Admin can cancel an active pending DEX proposal.

### Fields added
- In `Config` (`src/state/config.rs`):
  - `pub dex_program: Pubkey`: The currently active DEX program ID (initialized to `DEX_PROGRAM_ID`).
  - `pub pending_dex: Option<Pubkey>`: The pending DEX program ID awaiting timelock completion.
  - `pub dex_change_ready_at: i64`: Unix timestamp when the pending DEX change can be applied.

### Constraints and checks added
- In `src/instructions/settle.rs`: Enforces `Clock::now < round.deadline + REFUND_DELAY`, closing the settlement window once the refund period begins.
- In `src/instructions/join_with_swap.rs`: Replaced hardcoded `#[account(address = DEX_PROGRAM_ID)]` with dynamic `#[account(address = config.dex_program)]`.

### Delays chosen and justification
- `REFUND_DELAY = 3600` (1 hour): Gives the rollup executor a generous 1-hour window following the round's deadline to finalize and settle the round on Solana. If the rollup stops or crashes, players are not locked out indefinitely and can reclaim their stakes.
- `DEX_CHANGE_DELAY = 259_200` (3 days / 72 hours): Provides a 72-hour delay on swap venue changes. If the admin key is compromised, this timelock gives users and automated watchers 3 days to detect the rogue proposal, alert the community, and stop using `join_with_swap`.
