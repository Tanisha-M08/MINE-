import { assert } from "chai";
import { Keypair } from "@solana/web3.js";

import { getTime, oneToken, timeTravel, tokenBalance } from "../helpers";
import { RoundFixture, setupRounds } from "./fixture";
import {
  applyDex,
  cancelDexProposal,
  join,
  openRound,
  proposeDex,
  refund,
  settle,
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

describe("09-write-the-exit", () => {
  let env: RoundFixture;

  beforeEach(async () => {
    env = await setupRounds();
  });

  it("pays the whole pot to the winner the executor names", async () => {
    const [alice, bob] = env.players;
    const deadline = (await getTime(env.context)) + 60n;
    await openRound(env, 1, deadline);
    await join(env, 1, alice, oneToken().muln(100));
    await join(env, 1, bob, oneToken().muln(50));

    await timeTravel(env.context, deadline);
    const before = await tokenBalance(env.context, bob.tokens);
    await settle(env, 1, bob);
    const after = await tokenBalance(env.context, bob.tokens);

    assert.equal((after - before).toString(), oneToken().muln(150).toString());
    const round = await env.program.account.round.fetch(env.round(1));
    assert.isTrue(round.settled);
  });

  it("allows players to refund their stakes when the executor never settles", async () => {
    const [alice, bob] = env.players;
    const deadline = (await getTime(env.context)) + 60n;
    await openRound(env, 2, deadline);
    await join(env, 2, alice, oneToken().muln(100));
    await join(env, 2, bob, oneToken().muln(50));

    const aliceBefore = await tokenBalance(env.context, alice.tokens);
    const bobBefore = await tokenBalance(env.context, bob.tokens);

    // Advance time past deadline + REFUND_DELAY (3600 seconds)
    await timeTravel(env.context, deadline + 3601n);

    // Alice refunds her 100 tokens
    await refund(env, 2, alice);
    const aliceAfter = await tokenBalance(env.context, alice.tokens);
    assert.equal(
      (aliceAfter - aliceBefore).toString(),
      oneToken().muln(100).toString(),
      "Alice must recover her exact stake",
    );

    // Bob refunds his 50 tokens
    await refund(env, 2, bob);
    const bobAfter = await tokenBalance(env.context, bob.tokens);
    assert.equal(
      (bobAfter - bobBefore).toString(),
      oneToken().muln(50).toString(),
      "Bob must recover his exact stake",
    );

    const round = await env.program.account.round.fetch(env.round(2));
    assert.equal(round.pot.toString(), "0", "Round pot should be 0 after all refunds");

    // Alice cannot refund twice
    await catchError(
      refund(env, 2, alice),
      "NothingToRefund",
      "0x1777",
    );
  });

  it("refuses refund before the settlement window expires", async () => {
    const [alice] = env.players;
    const deadline = (await getTime(env.context)) + 60n;
    await openRound(env, 3, deadline);
    await join(env, 3, alice, oneToken().muln(100));

    // Advance time to deadline + 10s (settlement window is still active)
    await timeTravel(env.context, deadline + 10n);

    await catchError(
      refund(env, 3, alice),
      "RefundTooEarly",
      "0x1776",
    );
  });

  it("refuses settle after the settlement window expires", async () => {
    const [alice] = env.players;
    const deadline = (await getTime(env.context)) + 60n;
    await openRound(env, 4, deadline);
    await join(env, 4, alice, oneToken().muln(100));

    // Advance time past deadline + 3600s
    await timeTravel(env.context, deadline + 3601n);

    await catchError(
      settle(env, 4, alice),
      "SettlementExpired",
      "0x1775",
    );
  });

  it("refuses refund if the round was already settled", async () => {
    const [alice] = env.players;
    const deadline = (await getTime(env.context)) + 60n;
    await openRound(env, 5, deadline);
    await join(env, 5, alice, oneToken().muln(100));

    // Settle inside the window
    await timeTravel(env.context, deadline);
    await settle(env, 5, alice);

    // Advance time past delay
    await timeTravel(env.context, deadline + 3601n);

    await catchError(
      refund(env, 5, alice),
      "AlreadySettled",
      "0x1773",
    );
  });

  it("replaces DEX venue with a timelock delay", async () => {
    const newDex = Keypair.generate().publicKey;

    // 1. Propose new DEX
    await proposeDex(env, newDex);

    let config = await env.program.account.config.fetch(env.config);
    assert.isNotNull(config.pendingDex);
    assert.equal(config.pendingDex!.toBase58(), newDex.toBase58());

    // 2. Cannot apply immediately before delay
    await catchError(
      applyDex(env),
      "DexChangeNotReady",
      "0x1779",
    );

    // 3. Advance time past DEX_CHANGE_DELAY (259_200s / 3 days)
    const now = await getTime(env.context);
    await timeTravel(env.context, now + 259_201n);

    // 4. Apply succeeds
    await applyDex(env);

    config = await env.program.account.config.fetch(env.config);
    assert.equal(config.dexProgram.toBase58(), newDex.toBase58());
    assert.isNull(config.pendingDex);
    assert.equal(config.dexChangeReadyAt.toString(), "0");
  });

  it("allows admin to cancel a pending DEX proposal", async () => {
    const newDex = Keypair.generate().publicKey;
    await proposeDex(env, newDex);

    let config = await env.program.account.config.fetch(env.config);
    assert.isNotNull(config.pendingDex);

    // Cancel proposal
    await cancelDexProposal(env);

    config = await env.program.account.config.fetch(env.config);
    assert.isNull(config.pendingDex);
    assert.equal(config.dexChangeReadyAt.toString(), "0");
  });

  it("refuses DEX proposal from unauthorized non-admin", async () => {
    const nonAdmin = env.players[0].keypair;
    const newDex = Keypair.generate().publicKey;

    await catchError(
      proposeDex(env, newDex, nonAdmin),
      "ConstraintHasOne",
      "0x7d1",
    );
  });
});
