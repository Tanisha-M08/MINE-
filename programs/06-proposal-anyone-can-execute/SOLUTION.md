# Solution

## Why anyone may execute

What makes it safe to let a stranger send the execute transaction? What can the executor change, and what can they not?

- **Why it is safe:**
  The multisig relies on a **commit-execution split** where authorization and execution are decoupled:
  1. **Authorization (Commit phase):** The entire action is committed to on-chain state as data inside the `Proposal` PDA at creation time (target `program_id`, exact `metas`, and instruction `data`). Authorized multisig members review and sign on-chain approvals one by one until the required `threshold` is satisfied.
  2. **Execution phase:** Once quorum is reached, the transaction has already received cryptographic consent from the required members. The caller who executes the proposal acts purely as an untrusted crank/relayer.

- **What the executor can change:**
  Only the timing of transaction submission and the wallet paying the Solana transaction network fee.

- **What the executor cannot change:**
  1. The target program ID (`require_keys_eq!(program_account.key(), proposal.program_id)`).
  2. The account list: Every account in `remaining_accounts` is checked one-by-one against `proposal.metas` for matching `pubkey` and matching `is_writable`.
  3. Signers: The executor cannot inject external signers or make unauthorized accounts signers (`signer only for the vault PDA`).
  4. The instruction data payload (`proposal.data` is stored on-chain and passed verbatim).
  5. The execution count: The proposal executes exactly once; subsequent attempts fail with `MultisigError::AlreadyExecuted`.

If the executor modifies a single account, swaps order, changes writability, or points to another program, execution aborts with `MultisigError::AccountMismatch`.

## What the PDA signs

What exactly does the vault PDA sign at execution, and why can it not sign anything that is not in the proposal account?

- **What the vault PDA signs:**
  The vault PDA signs only the inner CPI invocation (`invoke_signed`) dispatched to the target program. Solana's runtime validates the program's PDA seeds (`[b"vault", &[config.vault_bump]]`) and elevates the vault PDA's `is_signer` privilege strictly for the scope of that single cross-program invocation.

- **Why it cannot sign anything outside the proposal account:**
  1. The multisig program constructs the `Instruction` passed to `invoke_signed` solely using the fields stored in the `Proposal` account (`proposal.program_id`, `metas` from `proposal.metas`, and `proposal.data`). It accepts no instruction arguments from the transaction caller.
  2. The program enforces that only the vault PDA may have `is_signer: true` in the stored metas. The multisig program has the derivation seeds to sign only for its own vault PDA; it cannot sign for any arbitrary account.
  3. `invoke_signed` is only reached after verifying that member approvals meet or exceed `config.threshold`, the proposal has not already executed, and the passed accounts match the stored proposal.
  4. Once `invoke_signed` succeeds, `proposal.executed = true` is committed, permanently consuming the proposal so the PDA signature cannot be re-triggered.

## What stays with the members

Which actions still need a member's or the proposer's signature, and why?

- **Actions requiring member signatures:**
  1. `create_proposal`: Requires a multisig member's signature (`ctx.accounts.config.is_member(&proposer.key())`). Only members can author proposals that attempt to act on behalf of the DAO or spend vault assets, preventing untrusted spam proposals.
  2. `approve`: Requires each voting member's cryptographic signature (`ctx.accounts.config.is_member(&member.key())`). Approvals represent governance authority; each member signs once, and duplicate approvals are rejected with `MultisigError::AlreadyApproved`.
  3. `cancel` (before expiration): Requires the proposer or a member's signature. Before expiry, only stakeholders who belong to the multisig or proposed the action have the authority to cancel a pending proposal.

- **Why execution does not need a member:**
  Governance intent and authorization are fully established once approvals cross the threshold. Requiring a member or admin key to trigger execution would create an operational bottleneck, reintroduce a centralized server dependency, and create a single point of failure.

## The exits

How does a proposal that never reaches the threshold end, and who pays for the account until then?

- **How it ends:**
  1. **Manual Cancellation:** Before execution, the proposer or any multisig member can call `cancel` to abort the proposal.
  2. **Permissionless Expiry:** If a proposal reaches `expires_at` without executing, anyone (including non-member bots or strangers) can call `cancel` to close the expired account.
     In both cases, `cancel` closes the `Proposal` account and reclaims its lamports.

- **Who pays for the account until then:**
  The **proposer** pays the rent-exemption deposit to allocate the `Proposal` account upon creation (`payer = proposer` in `create_proposal`). When the proposal is closed via `cancel`, Anchor transfers 100% of the account's lamports directly back to `proposal.proposer` (`close = proposer`), guaranteeing that the proposer's locked rent is safely returned.
