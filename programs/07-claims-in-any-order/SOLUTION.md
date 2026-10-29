# Solution

## Why a total commutes and a step does not

Show with two messages what happens to the paid amount in each order, and what a duplicate does, for the given program and for yours.

- **With delta steps and nonces (the original program):**
  - Suppose the oracle signs two daily increments: $M_1 = (\Delta = 30, \text{nonce} = 1)$ and $M_2 = (\Delta = 40, \text{nonce} = 2)$.
  - **In-order ($M_1$ then $M_2$):**
    - $M_1$ arrives: `nonce` matches ($0 + 1 = 1$). Pays 30. `paid = 30`, `nonce = 1`.
    - $M_2$ arrives: `nonce` matches ($1 + 1 = 2$). Pays 40. `paid = 70`, `nonce = 2`.
    - Result: `paid = 70`.
  - **Out-of-order ($M_2$ then $M_1$):**
    - $M_2$ arrives first: `nonce == 2 != 0 + 1`. Fails with `BadNonce`!
    - $M_1$ arrives second: `nonce == 1 == 0 + 1`. Succeeds. Pays 30. `paid = 30`, `nonce = 1`.
    - Result: $M_2$ is rejected permanently. Final `paid = 30`. Order permanently alters the payout ($30 \ne 70$).
  - **Duplicate message:**
    - If $M_1$ lands twice without nonces, it pays twice ($30 + 30 = 60$). With nonces, a duplicate fails, but any dropped message creates an unrecoverable gap.

- **With cumulative totals (our program):**
  - Suppose the oracle signs cumulative lifetime earnings: $M_1 = (\text{total} = 30)$ and $M_2 = (\text{total} = 70)$.
  - **In-order ($M_1$ then $M_2$):**
    - $M_1$ arrives: $\text{total} (30) > \text{paid} (0)$. Payout = $30 - 0 = 30$. `paid` becomes 30.
    - $M_2$ arrives: $\text{total} (70) > \text{paid} (30)$. Payout = $70 - 30 = 40$. `paid` becomes 70.
    - Result: Total received = $30 + 40 = 70$, `paid = 70`.
  - **Out-of-order ($M_2$ then $M_1$):**
    - $M_2$ arrives first: $\text{total} (70) > \text{paid} (0)$. Payout = $70 - 0 = 70$. `paid` becomes 70.
    - $M_1$ arrives second: $\text{total} (30) \le \text{paid} (70)$. Payout = 0 (changes nothing). `paid` remains 70.
    - Result: Total received = 70, `paid = 70`.
    - Both execution orders yield the exact same final state ($f(M_1, M_2) = f(M_2, M_1) = 70$).
  - **Duplicate message:**
    - If $M_2$ is submitted twice, the second execution observes $\text{total} (70) \le \text{paid} (70)$. It transfers 0 tokens and leaves `device.paid` at 70 without error. Execution is strictly idempotent ($f(M, M) = f(M)$).

## What the program compares

What does `claim` compare the message with, and what does it never compare it with?

- **What `claim` compares the message with:**
  1. **Instructions sysvar address**: The sysvar account address is validated against `solana_program::sysvar::instructions::ID` both declaratively (`#[account(address = ix_sysvar::ID @ ClaimError::NotEd25519)]`) and imperatively via `require_keys_eq!` before any bytes or instruction indices are accessed.
  2. **Ed25519 precompile instruction parser**:
     - The parser (`parse_ed25519`) loads the preceding instruction `(current_index - 1)` after asserting `current_index > 0`.
     - It checks `ix.program_id == ed25519_program::ID` (`ClaimError::NotEd25519`), ensuring the native Ed25519 precompile ran and verified the signature.
     - It checks header length ($\ge 16$ bytes) and signature count (`data[0] == 1`).
     - It validates offsets (`sig_ix == 0xffff`, `pk_ix == 0xffff`, `msg_ix == 0xffff`) ensuring the signature, public key, and message data are embedded in this instruction.
     - It bounds-checks slice offsets against buffer length before safely extracting the 32-byte public key and message.
     - The complete parser implementation is embedded directly in both `instructions/claim.rs` and `ed25519.rs`.
  3. **Stored oracle key**: The signature's recovered public key is compared with `config.oracle` stored in the program's configuration PDA (`ClaimError::WrongSigner`).
  4. **Signed payload**: The signed message bytes are compared with the expected serialization of `(device_pubkey || total)` (40 bytes: 32 bytes device + 8 bytes total LE) (`ClaimError::MessageMismatch`).
  5. **High-water mark**: The signed `total` is compared with the on-chain `device.paid` balance: if $\text{total} > \text{paid}$, it pays the difference $(\text{total} - \text{paid})$ and advances $\text{paid} \gets \text{total}$; otherwise it does nothing.

- **What it never compares it with:**
  - It **never** compares the message with a sequence counter, nonce, or timestamp.
  - It **never** compares the message with any history, log, bitmap, or set of previously observed messages or transaction signatures.

## Why the nonce could go

What did the nonce guarantee, what did it not guarantee, and what makes it unnecessary in your version?

- **What the nonce guaranteed:**
  It guaranteed strict, sequential ordering ($n \to n+1$). It ensured that message $n$ could not be executed more than once _if_ messages strictly arrived in sequential order.
- **What it did not guarantee:**
  It did not guarantee liveness or delivery resilience. If any single message was dropped, delayed, or lost in the network, all subsequent claims were blocked forever. It also broke completely if two valid transactions arrived out of order.
- **What makes it unnecessary:**
  Monotonic cumulative totals form a **join-semilattice** / one-way state machine where state updates only move forward: $\text{paid} \gets \max(\text{paid}, \text{total})$. Because the current on-chain state already represents the high-water mark of everything paid to date, any older or replayed message is naturally subsumed as a benign no-op. The nonce and nonce storage are completely superfluous.

## The boundary of the oracle's consent

What exactly does the oracle sign, and what can a claim never do beyond what was signed?

- **What the oracle signs:**
  The oracle signs an absolute, cumulative consent: _"Device `D` has earned a total lifetime reward of `T` tokens."_
- **What a claim can never do beyond what was signed:**
  1. **Cannot overpay:** A claim can never cause total payouts to exceed $T$. Since the payout is bounded by $T - \text{paid}$ and immediately increases `paid` to $T$, cumulative tokens transferred will never exceed $T$.
  2. **Cannot decrease paid amount:** The program enforces that `paid` only increases, preventing rollbacks or double-spending.
  3. **Cannot redirect funds:** The message explicitly binds to the `device` account address, and transfers are constrained by Anchor to `device.owner`'s token account (`token::authority = device.owner`).
  4. Even under arbitrary network reordering, packet loss, or malicious replay attacks, the protocol can never transfer a single token beyond what the oracle cryptographically authorized.
