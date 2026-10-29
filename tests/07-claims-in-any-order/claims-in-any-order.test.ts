import { assert } from "chai";
import { Keypair, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { oneToken, sendIxs, tokenBalance } from "../helpers";
import { ClaimsFixture, setupClaims } from "./fixture";
import { claim, claimMessage } from "./actions";

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

describe("07-claims-in-any-order", () => {
  let env: ClaimsFixture;

  beforeEach(async () => {
    env = await setupClaims();
  });

  it("pays a reward the oracle signed (happy path)", async () => {
    await claim(env, oneToken().muln(10));
    assert.equal(
      (await tokenBalance(env.context, env.ownerTokens)).toString(),
      oneToken().muln(10).toString(),
    );
    const device = await env.program.account.device.fetch(env.device);
    assert.equal(device.paid.toString(), oneToken().muln(10).toString());
  });

  it("two claims sent in increasing order (older total then newer total)", async () => {
    // 1. Claim older total: 30 tokens
    await claim(env, oneToken().muln(30));
    assert.equal(
      (await tokenBalance(env.context, env.ownerTokens)).toString(),
      oneToken().muln(30).toString(),
    );
    let device = await env.program.account.device.fetch(env.device);
    assert.equal(device.paid.toString(), oneToken().muln(30).toString());

    // 2. Claim newer total: 70 tokens (difference of 40 tokens paid)
    await claim(env, oneToken().muln(70));
    assert.equal(
      (await tokenBalance(env.context, env.ownerTokens)).toString(),
      oneToken().muln(70).toString(),
    );
    device = await env.program.account.device.fetch(env.device);
    assert.equal(device.paid.toString(), oneToken().muln(70).toString());
  });

  it("two claims sent in reverse order (newer total then older total) ends in the exact same state", async () => {
    // 1. Claim newer total first: 70 tokens
    await claim(env, oneToken().muln(70));
    assert.equal(
      (await tokenBalance(env.context, env.ownerTokens)).toString(),
      oneToken().muln(70).toString(),
    );
    let device = await env.program.account.device.fetch(env.device);
    assert.equal(device.paid.toString(), oneToken().muln(70).toString());

    // 2. Claim older total second: 30 tokens (at or below paid amount -> changes nothing)
    await claim(env, oneToken().muln(30));
    assert.equal(
      (await tokenBalance(env.context, env.ownerTokens)).toString(),
      oneToken().muln(70).toString(),
      "Balance remains 70 after out-of-order claim",
    );
    device = await env.program.account.device.fetch(env.device);
    assert.equal(
      device.paid.toString(),
      oneToken().muln(70).toString(),
      "Paid amount remains 70 and never decreases",
    );
  });

  it("sending the same claim twice changes nothing on the second call and ends in the same state", async () => {
    // 1. First claim: 50 tokens
    await claim(env, oneToken().muln(50));
    assert.equal(
      (await tokenBalance(env.context, env.ownerTokens)).toString(),
      oneToken().muln(50).toString(),
    );
    let device = await env.program.account.device.fetch(env.device);
    assert.equal(device.paid.toString(), oneToken().muln(50).toString());

    // 2. Replay duplicate claim: 50 tokens again
    await claim(env, oneToken().muln(50));
    assert.equal(
      (await tokenBalance(env.context, env.ownerTokens)).toString(),
      oneToken().muln(50).toString(),
      "Balance must not change on duplicate claim",
    );
    device = await env.program.account.device.fetch(env.device);
    assert.equal(
      device.paid.toString(),
      oneToken().muln(50).toString(),
      "Paid amount must not change on duplicate claim",
    );
  });

  it("refuses a claim signed by an unauthorized key (not the oracle)", async () => {
    const fakeOracle = Keypair.generate();
    await catchError(
      claim(env, oneToken().muln(10), env.payer, fakeOracle),
      "WrongSigner",
      "0x1773",
    );
  });

  it("refuses a claim when the signed message does not match the claim amount", async () => {
    // Oracle signs message for 100 tokens, but claim is called with 50 tokens
    const mismatchedMessage = claimMessage(env.device, oneToken().muln(100));
    await catchError(
      claim(
        env,
        oneToken().muln(50),
        env.payer,
        env.oracle,
        undefined,
        mismatchedMessage,
      ),
      "MessageMismatch",
      "0x1774",
    );
  });

  it("refuses a claim when passed a fake instructions sysvar", async () => {
    const fakeSysvar = Keypair.generate().publicKey;
    await catchError(
      claim(env, oneToken().muln(10), env.payer, env.oracle, fakeSysvar),
      "NotEd25519",
      "0x1771",
    );
  });

  it("refuses a claim when the instruction before it is missing", async () => {
    const ix = await env.program.methods
      .claim(oneToken().muln(10))
      .accountsPartial({
        caller: env.payer.publicKey,
        device: env.device,
        mint: env.mint,
        ownerTokens: env.ownerTokens,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    await catchError(
      sendIxs(env.context, [env.payer], ix),
      "NotEd25519",
      "0x1771",
    );
  });

  it("refuses a claim when preceded by an instruction that is not Ed25519", async () => {
    const dummyIx = SystemProgram.transfer({
      fromPubkey: env.payer.publicKey,
      toPubkey: env.payer.publicKey,
      lamports: 0,
    });
    const ix = await env.program.methods
      .claim(oneToken().muln(10))
      .accountsPartial({
        caller: env.payer.publicKey,
        device: env.device,
        mint: env.mint,
        ownerTokens: env.ownerTokens,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    await catchError(
      sendIxs(env.context, [env.payer], dummyIx, ix),
      "NotEd25519",
      "0x1771",
    );
  });
});
