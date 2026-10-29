import { BN } from "@coral-xyz/anchor";
import {
  AccountMeta,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { createTransferInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { getTime, sendIxs } from "../helpers";
import { MultisigFixture } from "./fixture";

/** A token transfer from the treasury, signed by the vault PDA, as the instruction to store. */
export const treasuryTransfer = (
  env: MultisigFixture,
  to: PublicKey,
  amount: BN,
): TransactionInstruction =>
  createTransferInstruction(
    env.treasury,
    to,
    env.vault,
    BigInt(amount.toString()),
  );

export const createProposal = async (
  env: MultisigFixture,
  id: number,
  proposer: Keypair,
  instruction: TransactionInstruction,
  expiresInSeconds = 3600,
) => {
  const expiresAt = (await getTime(env.context)) + BigInt(expiresInSeconds);
  const ix = await env.program.methods
    .createProposal(
      new BN(id),
      instruction.programId,
      instruction.keys.map((k) => ({
        pubkey: k.pubkey,
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      Buffer.from(instruction.data),
      new BN(expiresAt.toString()),
    )
    .accountsPartial({
      proposer: proposer.publicKey,
      proposal: env.proposal(id),
    })
    .instruction();
  await sendIxs(env.context, [proposer], ix);
};

export const approve = async (
  env: MultisigFixture,
  id: number,
  member: Keypair,
) => {
  const ix = await env.program.methods
    .approve()
    .accountsPartial({ member: member.publicKey, proposal: env.proposal(id) })
    .instruction();
  await sendIxs(env.context, [member], ix);
};

/** Executes a proposal, passing the stored instruction's accounts and its program as remaining accounts. */
export const execute = async (
  env: MultisigFixture,
  id: number,
  executor: Keypair,
  instruction: TransactionInstruction,
  remaining?: AccountMeta[],
) => {
  const accounts: AccountMeta[] = remaining ?? [
    ...instruction.keys.map((k) => ({
      pubkey: k.pubkey,
      isSigner: false,
      isWritable: k.isWritable,
    })),
    { pubkey: instruction.programId, isSigner: false, isWritable: false },
  ];
  const ix = await env.program.methods
    .execute()
    .accountsPartial({
      executor: executor.publicKey,
      proposal: env.proposal(id),
    })
    .remainingAccounts(accounts)
    .instruction();
  await sendIxs(env.context, [executor], ix);
};

export const cancel = async (
  env: MultisigFixture,
  id: number,
  caller: Keypair,
  proposer?: PublicKey,
) => {
  const proposalPda = env.proposal(id);
  const targetProposer =
    proposer ??
    (await env.program.account.proposal.fetch(proposalPda)).proposer;
  const ix = await env.program.methods
    .cancel()
    .accountsPartial({
      caller: caller.publicKey,
      proposal: proposalPda,
      proposer: targetProposer,
    })
    .instruction();
  await sendIxs(env.context, [caller], ix);
};

export { TOKEN_PROGRAM_ID };
