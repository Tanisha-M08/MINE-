import { assert } from "chai";
import { Keypair, SystemProgram } from "@solana/web3.js";

import { getTime, oneToken, timeTravel, tokenBalance } from "../helpers";
import { MultisigFixture, setupMultisig } from "./fixture";
import {
  approve,
  cancel,
  createProposal,
  execute,
  treasuryTransfer,
} from "./actions";

const catchError = async (
  promise: Promise<unknown>,
  expectedName: string,
  expectedHex: string,
): Promise<void> => {
  let err: Error | null = null;
  try {
    await promise;
  } catch (e) {
    err = e as Error;
  }
  assert.isNotNull(err, `Expected error ${expectedName} (${expectedHex})`);
  const errStr = err!.toString();
  const matched = errStr.includes(expectedName) || errStr.includes(expectedHex);
  assert.isTrue(
    matched,
    `Error "${errStr}" must contain either "${expectedName}" or "${expectedHex}"`,
  );
};

describe("06-proposal-anyone-can-execute", () => {
  let env: MultisigFixture;

  beforeEach(async () => {
    env = await setupMultisig();
  });

  it("executes an approved transfer from the treasury with a non-member stranger executing", async () => {
    const [admin, bob] = env.members;
    const bobTokens = env.memberTokens(bob.publicKey);
    const transfer = treasuryTransfer(env, bobTokens, oneToken().muln(50));

    await createProposal(env, 1, bob, transfer);
    await approve(env, 1, admin);
    await approve(env, 1, bob);

    const before = await tokenBalance(env.context, bobTokens);

    // Stranger (not a multisig member, not admin) executes the proposal
    assert.isFalse(
      env.members.some((m) => m.publicKey.equals(env.stranger.publicKey)),
      "Stranger must not be a member",
    );
    await execute(env, 1, env.stranger, transfer);

    const after = await tokenBalance(env.context, bobTokens);
    assert.equal((after - before).toString(), oneToken().muln(50).toString());

    const proposal = await env.program.account.proposal.fetch(env.proposal(1));
    assert.isTrue(proposal.executed);
  });

  it("refuses execute below the approval threshold", async () => {
    const [, bob] = env.members;
    const bobTokens = env.memberTokens(bob.publicKey);
    const transfer = treasuryTransfer(env, bobTokens, oneToken().muln(20));

    await createProposal(env, 2, bob, transfer);
    // Only 1 approval (threshold is 2)
    await approve(env, 2, bob);

    await catchError(
      execute(env, 2, env.stranger, transfer),
      "NotApproved",
      "0x1774",
    );
  });

  it("refuses a second execute of the same proposal", async () => {
    const [admin, bob] = env.members;
    const bobTokens = env.memberTokens(bob.publicKey);
    const transfer = treasuryTransfer(env, bobTokens, oneToken().muln(30));

    await createProposal(env, 3, bob, transfer);
    await approve(env, 3, admin);
    await approve(env, 3, bob);

    // First execution succeeds
    await execute(env, 3, env.stranger, transfer);

    // Second execution must be refused
    await catchError(
      execute(env, 3, env.stranger, transfer),
      "AlreadyExecuted",
      "0x1775",
    );
  });

  it("refuses execute when the account list is changed", async () => {
    const [admin, bob] = env.members;
    const bobTokens = env.memberTokens(bob.publicKey);
    const transfer = treasuryTransfer(env, bobTokens, oneToken().muln(10));

    await createProposal(env, 4, bob, transfer);
    await approve(env, 4, admin);
    await approve(env, 4, bob);

    // 1. Wrong account pubkey (stranger's wallet instead of bobTokens)
    const rogueRecipient = Keypair.generate().publicKey;
    const tamperedAccounts1 = [
      { pubkey: transfer.keys[0].pubkey, isSigner: false, isWritable: true },
      { pubkey: rogueRecipient, isSigner: false, isWritable: true }, // swapped recipient
      { pubkey: transfer.keys[2].pubkey, isSigner: false, isWritable: false },
      { pubkey: transfer.programId, isSigner: false, isWritable: false },
    ];
    await catchError(
      execute(env, 4, env.stranger, transfer, tamperedAccounts1),
      "AccountMismatch",
      "0x1776",
    );

    // 2. Wrong writability (treasury passed as read-only instead of writable)
    const tamperedAccounts2 = [
      { pubkey: transfer.keys[0].pubkey, isSigner: false, isWritable: false }, // should be true
      { pubkey: transfer.keys[1].pubkey, isSigner: false, isWritable: true },
      { pubkey: transfer.keys[2].pubkey, isSigner: false, isWritable: false },
      { pubkey: transfer.programId, isSigner: false, isWritable: false },
    ];
    await catchError(
      execute(env, 4, env.stranger, transfer, tamperedAccounts2),
      "AccountMismatch",
      "0x1776",
    );

    // 3. Wrong program ID (SystemProgram instead of TokenProgram)
    const tamperedAccounts3 = [
      { pubkey: transfer.keys[0].pubkey, isSigner: false, isWritable: true },
      { pubkey: transfer.keys[1].pubkey, isSigner: false, isWritable: true },
      { pubkey: transfer.keys[2].pubkey, isSigner: false, isWritable: false },
      {
        pubkey: SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      }, // wrong program
    ];
    await catchError(
      execute(env, 4, env.stranger, transfer, tamperedAccounts3),
      "AccountMismatch",
      "0x1776",
    );

    // 4. Missing remaining accounts
    const tamperedAccounts4 = [
      { pubkey: transfer.keys[0].pubkey, isSigner: false, isWritable: true },
    ];
    await catchError(
      execute(env, 4, env.stranger, transfer, tamperedAccounts4),
      "AccountMismatch",
      "0x1776",
    );
  });

  it("allows proposer or member to cancel an unexecuted proposal and recover rent", async () => {
    const [, bob] = env.members;
    const bobTokens = env.memberTokens(bob.publicKey);
    const transfer = treasuryTransfer(env, bobTokens, oneToken().muln(15));

    await createProposal(env, 5, bob, transfer);
    const proposalPda = env.proposal(5);

    const rentBefore = await env.context.banksClient.getBalance(bob.publicKey);

    // Proposer cancels the proposal
    await cancel(env, 5, bob);

    const rentAfter = await env.context.banksClient.getBalance(bob.publicKey);
    assert.isTrue(
      rentAfter > rentBefore,
      "Proposer balance must increase after receiving rent refund",
    );

    // Verify account is closed
    const accountInfo = await env.context.banksClient.getAccount(proposalPda);
    assert.isNull(accountInfo, "Proposal account must be closed");
  });

  it("refuses cancel by a stranger before expiry", async () => {
    const [, bob] = env.members;
    const bobTokens = env.memberTokens(bob.publicKey);
    const transfer = treasuryTransfer(env, bobTokens, oneToken().muln(15));

    await createProposal(env, 6, bob, transfer, 3600);

    // Stranger tries to cancel before expiry
    await catchError(cancel(env, 6, env.stranger), "NotAMember", "0x1771");
  });

  it("allows anyone (stranger) to close a proposal past expires_at and refunds the proposer", async () => {
    const [, bob] = env.members;
    const bobTokens = env.memberTokens(bob.publicKey);
    const transfer = treasuryTransfer(env, bobTokens, oneToken().muln(15));

    // Expires in 10 seconds
    await createProposal(env, 7, bob, transfer, 10);
    const proposalPda = env.proposal(7);

    // Warp time past expiry
    const now = await getTime(env.context);
    await timeTravel(env.context, now + 30n);

    const bobBalanceBefore = await env.context.banksClient.getBalance(
      bob.publicKey,
    );

    // Stranger closes the expired proposal
    await cancel(env, 7, env.stranger);

    const bobBalanceAfter = await env.context.banksClient.getBalance(
      bob.publicKey,
    );
    assert.isTrue(
      bobBalanceAfter > bobBalanceBefore,
      "Proposer receives rent refund upon expired proposal close",
    );

    const accountInfo = await env.context.banksClient.getAccount(proposalPda);
    assert.isNull(accountInfo, "Proposal account must be closed");
  });

  it("refuses cancel on an already executed proposal", async () => {
    const [admin, bob] = env.members;
    const bobTokens = env.memberTokens(bob.publicKey);
    const transfer = treasuryTransfer(env, bobTokens, oneToken().muln(25));

    await createProposal(env, 8, bob, transfer);
    await approve(env, 8, admin);
    await approve(env, 8, bob);

    await execute(env, 8, env.stranger, transfer);

    // Attempting to cancel an executed proposal
    await catchError(cancel(env, 8, bob), "AlreadyExecuted", "0x1775");
  });
});
