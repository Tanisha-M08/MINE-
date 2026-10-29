import { assert } from "chai";

import { oneToken, tokenBalance } from "../helpers";
import { PoolFixture, setupPool } from "./fixture";
import { addRewards, claim, stake, unstake } from "./actions";

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
  assert.isNotNull(err, `Instruction must fail with ${expectedName} (${expectedHex})`);
  const errStr = err!.toString();
  const matched =
    errStr.includes(expectedName) || errStr.includes(expectedHex);
  assert.isTrue(
    matched,
    `Error "${errStr}" must contain either "${expectedName}" or "${expectedHex}"`,
  );
};

describe("04-rewards-without-a-loop", () => {
  let env: PoolFixture;

  beforeEach(async () => {
    env = await setupPool();
  });

  it("splits a reward between three stakers in proportion to their stake", async () => {
    const [a, b, c] = env.stakers;
    await stake(env, a, oneToken().muln(100));
    await stake(env, b, oneToken().muln(300));
    await stake(env, c, oneToken().muln(600));
    const before = await Promise.all(
      env.stakers.map((s) => tokenBalance(env.context, s.tokens)),
    );

    await addRewards(env, oneToken().muln(100));
    await claim(env, a);
    await claim(env, b);
    await claim(env, c);

    const after = await Promise.all(
      env.stakers.map((s) => tokenBalance(env.context, s.tokens)),
    );
    assert.equal(
      (after[0] - before[0]).toString(),
      oneToken().muln(10).toString(),
    );
    assert.equal(
      (after[1] - before[1]).toString(),
      oneToken().muln(30).toString(),
    );
    assert.equal(
      (after[2] - before[2]).toString(),
      oneToken().muln(60).toString(),
    );
  });

  it("pays the right amount in whatever order stakers claim with rewards between actions", async () => {
    const [a, b, c] = env.stakers;

    // A stakes 100, B stakes 200, C stakes 200 (total = 500)
    await stake(env, a, oneToken().muln(100));
    await stake(env, b, oneToken().muln(200));
    await stake(env, c, oneToken().muln(200));

    const before = await Promise.all(
      env.stakers.map((s) => tokenBalance(env.context, s.tokens)),
    );

    // Reward 1: 100 tokens (A: 20%, B: 40%, C: 40%) => A owes 20, B owes 40, C owes 40
    await addRewards(env, oneToken().muln(100));

    // B claims early (in whatever order)
    await claim(env, b);
    const bMid = await tokenBalance(env.context, b.tokens);
    assert.equal(
      (bMid - before[1]).toString(),
      oneToken().muln(40).toString(),
      "B received correct reward from round 1",
    );

    // A stakes 300 more: A now has 400, B has 200, C has 200 (total = 800)
    await stake(env, a, oneToken().muln(300));

    // Reward 2: 160 tokens (A: 400/800 = 50%, B: 200/800 = 25%, C: 200/800 = 25%)
    // Round 2 gives: A +80, B +40, C +40
    await addRewards(env, oneToken().muln(160));

    // Claim in arbitrary order: C claims, then B claims, then A claims
    await claim(env, c); // C receives Round 1 (40) + Round 2 (40) = 80
    await claim(env, b); // B receives Round 2 (40)
    await claim(env, a); // A receives Round 1 (20) + Round 2 (80) = 100

    const after = await Promise.all(
      env.stakers.map((s) => tokenBalance(env.context, s.tokens)),
    );

    // Total rewards received (accounting for A's extra 300 deposit):
    // A started with before[0], deposited 300, received 100 reward => net is before[0] - 200
    const extraDepositA = BigInt(oneToken().muln(300).toString());
    assert.equal(
      (after[0] - before[0] + extraDepositA).toString(),
      oneToken().muln(100).toString(),
      "A received exactly 100 tokens of rewards (20 + 80)",
    );
    // B received 40 + 40 = 80
    assert.equal(
      (after[1] - before[1]).toString(),
      oneToken().muln(80).toString(),
      "B received exactly 80 tokens of rewards (40 + 40)",
    );
    // C received 40 + 40 = 80
    assert.equal(
      (after[2] - before[2]).toString(),
      oneToken().muln(80).toString(),
      "C received exactly 80 tokens of rewards (40 + 40)",
    );
  });

  it("a deposit does not change what was owed before it", async () => {
    const [a, b] = env.stakers;

    // A stakes 100, B stakes 100 (total = 200, 50% each)
    await stake(env, a, oneToken().muln(100));
    await stake(env, b, oneToken().muln(100));

    // Reward of 100 arrives => A is owed 50, B is owed 50
    await addRewards(env, oneToken().muln(100));

    // A deposits 300 more tokens. Settle happens BEFORE stake changes!
    const aAccountBeforeDeposit = await env.program.account.staker.fetch(a.account);
    assert.equal(
      aAccountBeforeDeposit.pending.toString(),
      "0",
      "Pending was 0 before settlement",
    );

    await stake(env, a, oneToken().muln(300));

    // After deposit, A's pending must be exactly 50 (settled at 100 stake, not 400)
    const aAccountAfterDeposit = await env.program.account.staker.fetch(a.account);
    assert.equal(
      aAccountAfterDeposit.pending.toString(),
      oneToken().muln(50).toString(),
      "A's pending reward was locked at 50 tokens before the stake was raised",
    );

    // Now total stake is 400 (A) + 100 (B) = 500 (A is 80%, B is 20%)
    // Reward of 100 arrives => A earns 80, B earns 20
    await addRewards(env, oneToken().muln(100));

    const aBalBefore = await tokenBalance(env.context, a.tokens);
    await claim(env, a);
    const aBalAfter = await tokenBalance(env.context, a.tokens);

    // A receives 50 (from before deposit) + 80 (from after deposit) = 130
    assert.equal(
      (aBalAfter - aBalBefore).toString(),
      oneToken().muln(130).toString(),
      "A receives 50 from 1st period and 80 from 2nd period",
    );

    const bBalBefore = await tokenBalance(env.context, b.tokens);
    await claim(env, b);
    const bBalAfter = await tokenBalance(env.context, b.tokens);

    // B receives 50 (from 1st period) + 20 (from 2nd period) = 70
    assert.equal(
      (bBalAfter - bBalBefore).toString(),
      oneToken().muln(70).toString(),
      "B receives 50 from 1st period and 20 from 2nd period",
    );
  });

  it("a staker who never claims is owed exactly the right amount after all other stakers' actions", async () => {
    const [a, b, c] = env.stakers;

    // A stakes 100, B stakes 200, C stakes 300 (total = 600; C has 50%)
    await stake(env, a, oneToken().muln(100));
    await stake(env, b, oneToken().muln(200));
    await stake(env, c, oneToken().muln(300));

    const cBefore = await tokenBalance(env.context, c.tokens);

    // Round 1: 60 reward (C should get 30)
    await addRewards(env, oneToken().muln(60));

    // A and B claim and re-stake; C does nothing
    await claim(env, a);
    await claim(env, b);
    await stake(env, a, oneToken().muln(100)); // A now has 200; total = 700 (C has 300/700)

    // Round 2: 70 reward (C should get 30)
    await addRewards(env, oneToken().muln(70));

    // B unstakes 100 (B now has 100; total = 600; C has 300/600 = 50%)
    await unstake(env, b, oneToken().muln(100));
    await claim(env, b);

    // Round 3: 120 reward (C should get 60)
    await addRewards(env, oneToken().muln(120));

    // C finally claims after everyone else is done
    await claim(env, c);
    const cAfter = await tokenBalance(env.context, c.tokens);

    // C's total reward: 30 (round 1) + 30 (round 2) + 60 (round 3) = 120 tokens
    assert.equal(
      (cAfter - cBefore).toString(),
      oneToken().muln(120).toString(),
      "C was never touched but receives exact sum of all fractional rewards",
    );
  });

  it("unstake settles owed rewards before reducing stake", async () => {
    const [a, b] = env.stakers;

    await stake(env, a, oneToken().muln(200));
    await stake(env, b, oneToken().muln(200));

    // 100 reward => 50 each
    await addRewards(env, oneToken().muln(100));

    // A unstakes 100. Settle happens before stake reduction
    await unstake(env, a, oneToken().muln(100));

    const aAccount = await env.program.account.staker.fetch(a.account);
    assert.equal(
      aAccount.pending.toString(),
      oneToken().muln(50).toString(),
      "Pending reward was locked at 50 tokens before stake was reduced",
    );

    const before = await tokenBalance(env.context, a.tokens);
    await claim(env, a);
    const after = await tokenBalance(env.context, a.tokens);

    assert.equal(
      (after - before).toString(),
      oneToken().muln(50).toString(),
      "A claimed the 50 tokens settled during unstake",
    );
  });

  it("refuses to add rewards when nothing is staked", async () => {
    // Pool initialized with 0 stake
    await catchError(
      addRewards(env, oneToken().muln(100)),
      "NothingStaked",
      "0x1772",
    );
  });

  it("refuses to unstake more than staked", async () => {
    const [a] = env.stakers;
    await stake(env, a, oneToken().muln(50));

    await catchError(
      unstake(env, a, oneToken().muln(100)),
      "InsufficientStake",
      "0x1771",
    );
  });
});
