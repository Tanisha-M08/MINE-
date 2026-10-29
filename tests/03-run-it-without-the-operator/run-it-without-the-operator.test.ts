import { assert } from "chai";
import {
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

import { getTime, oneToken, sendIxs, toBN, tokenBalance } from "../helpers";
import { MAX_PRICE_AGE, RewardsFixture, setupRewards } from "./fixture";
import { accrue, buy, claim, priceMessage, setPrice } from "./actions";

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
  const matched =
    errStr.includes(expectedName) || errStr.includes(expectedHex);
  assert.isTrue(
    matched,
    `Error "${errStr}" must contain either "${expectedName}" or "${expectedHex}"`,
  );
};

describe("03-run-it-without-the-operator", () => {
  let env: RewardsFixture;

  beforeEach(async () => {
    env = await setupRewards();
  });

  it("pays a reward and sells tokens without an admin server or bot running", async () => {
    // 1. Admin accrues rewards for the user
    await accrue(env, env.user.publicKey, oneToken().muln(100));

    // 2. User claims their own rewards without fee deduction
    await claim(
      env,
      env.user,
      env.user.publicKey,
      env.userTokens,
      env.userTokens,
    );
    assert.equal(
      (await tokenBalance(env.context, env.userTokens)).toString(),
      oneToken().muln(100).toString(),
    );

    // 3. Price update brought by caller with oracle Ed25519 signature (no bot running)
    const price = toBN(LAMPORTS_PER_SOL / 100); // 0.01 SOL per token
    await setPrice(env, price, env.stranger);

    // 4. Stranger buys tokens at that price
    await buy(
      env,
      env.stranger,
      env.strangerTokens,
      toBN(LAMPORTS_PER_SOL / 10),
    );
    assert.equal(
      (await tokenBalance(env.context, env.strangerTokens)).toString(),
      oneToken().muln(10).toString(),
    );
  });

  it("a wallet that is neither admin nor bot claims for the user and keeps the fee", async () => {
    // Accrue 100 tokens to user
    await accrue(env, env.user.publicKey, oneToken().muln(100));

    const userBefore = await tokenBalance(env.context, env.userTokens);
    const strangerBefore = await tokenBalance(env.context, env.strangerTokens);

    // Stranger (permissionless crank) claims for user
    await claim(
      env,
      env.stranger,
      env.user.publicKey,
      env.userTokens,
      env.strangerTokens,
    );

    const userAfter = await tokenBalance(env.context, env.userTokens);
    const strangerAfter = await tokenBalance(env.context, env.strangerTokens);

    // 1% fee capped at 1 token: user receives 99 tokens, stranger receives 1 token fee
    const expectedUserGain = oneToken().muln(99);
    const expectedStrangerFee = oneToken().muln(1);

    assert.equal(
      (userAfter - userBefore).toString(),
      expectedUserGain.toString(),
      "User must receive pending reward minus caller fee",
    );
    assert.equal(
      (strangerAfter - strangerBefore).toString(),
      expectedStrangerFee.toString(),
      "Stranger must receive 1% caller fee (capped at 1 token)",
    );
  });

  it("refuses to claim twice", async () => {
    await accrue(env, env.user.publicKey, oneToken().muln(50));
    await claim(
      env,
      env.stranger,
      env.user.publicKey,
      env.userTokens,
      env.strangerTokens,
    );

    // Second claim immediately fails with NothingToPay (0x1771)
    await catchError(
      claim(
        env,
        env.stranger,
        env.user.publicKey,
        env.userTokens,
        env.strangerTokens,
      ),
      "NothingToPay",
      "0x1771",
    );
  });

  it("allows stranger to atomically update price and buy with zero bot activity", async () => {
    const price = toBN(LAMPORTS_PER_SOL / 50); // 0.02 SOL per token
    const now = await getTime(env.context);

    // Build Ed25519 signature instruction with oracle key
    const sigIx = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: env.oracle.secretKey,
      message: priceMessage(price, now),
    });

    const setPriceIx = await env.program.methods
      .setPrice(price)
      .accountsPartial({
        caller: env.stranger.publicKey,
      })
      .instruction();

    const buyIx = await env.program.methods
      .buy(toBN(LAMPORTS_PER_SOL / 5)) // 0.2 SOL => 10 tokens at 0.02 SOL/token
      .accountsPartial({
        buyer: env.stranger.publicKey,
        mint: env.mint,
        buyerTokens: env.strangerTokens,
      })
      .instruction();

    const before = await tokenBalance(env.context, env.strangerTokens);
    await sendIxs(env.context, [env.stranger], sigIx, setPriceIx, buyIx);
    const after = await tokenBalance(env.context, env.strangerTokens);

    assert.equal(
      (after - before).toString(),
      oneToken().muln(10).toString(),
      "Stranger bought tokens using atomically submitted pull price",
    );
  });

  it("refuses a price update older than max_price_age", async () => {
    const price = toBN(LAMPORTS_PER_SOL / 100);
    const now = await getTime(env.context);
    const staleTime = Number(now) - (MAX_PRICE_AGE + 1);

    await catchError(
      setPrice(
        env,
        price,
        env.stranger,
        env.oracle,
        staleTime,
      ),
      "StalePrice",
      "0x1772",
    );
  });

  it("refuses a price signed by an unauthorized key (bot instead of oracle)", async () => {
    const price = toBN(LAMPORTS_PER_SOL / 100);
    // Bot tries to sign the price update instead of the configured oracle
    await catchError(
      setPrice(
        env,
        price,
        env.stranger,
        env.bot,
      ),
      "KeyNotAllowed",
      "0x1776",
    );
  });

  it("refuses set_price without a preceding Ed25519 instruction", async () => {
    const price = toBN(LAMPORTS_PER_SOL / 100);
    // Send only set_price instruction without Ed25519 instruction
    const ix = await env.program.methods
      .setPrice(price)
      .accountsPartial({
        caller: env.stranger.publicKey,
      })
      .instruction();

    await catchError(
      sendIxs(env.context, [env.stranger], ix),
      "NotEd25519",
      "0x1773",
    );
  });

  it("refuses set_price when price does not match the signed message", async () => {
    const price = toBN(LAMPORTS_PER_SOL / 100);
    const wrongPrice = toBN(LAMPORTS_PER_SOL / 200);
    const now = await getTime(env.context);

    // Oracle signed wrongPrice, but caller submits price
    const wrongMessage = priceMessage(wrongPrice, now);

    await catchError(
      setPrice(
        env,
        price,
        env.stranger,
        env.oracle,
        now,
        undefined,
        wrongMessage,
      ),
      "PriceMismatch",
      "0x1778",
    );
  });

  it("refuses set_price when passed a fake instructions sysvar", async () => {
    const price = toBN(LAMPORTS_PER_SOL / 100);
    const fakeSysvar = Keypair.generate().publicKey;

    await catchError(
      setPrice(
        env,
        price,
        env.stranger,
        env.oracle,
        undefined,
        fakeSysvar,
      ),
      "WrongInstructionsSysvar",
      "0x1775",
    );
  });
});
