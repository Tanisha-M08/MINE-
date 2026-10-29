import { assert } from "chai";

import { getTime, oneToken, timeTravel, tokenBalance } from "../helpers";
import { MarketFixture, MAX_PRICE_AGE, setupMarket } from "./fixture";
import { borrow, deposit, liquidate } from "./actions";

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

describe("08-value-the-position", () => {
  let env: MarketFixture;

  beforeEach(async () => {
    env = await setupMarket();
  });

  it("borrows against deposited collateral", async () => {
    await env.setPrices([150, 1], [1, 0.001]);
    await deposit(env, oneToken().muln(10));

    const before = await tokenBalance(env.context, env.payerDebt);
    await borrow(env, oneToken().muln(1_000));
    const after = await tokenBalance(env.context, env.payerDebt);

    assert.equal((after - before).toString(), oneToken().muln(1_000).toString());
    const position = await env.program.account.position.fetch(
      env.position(env.payer.publicKey),
    );
    assert.equal(position.collateral.toString(), oneToken().muln(10).toString());
    assert.equal(position.debt.toString(), oneToken().muln(1_000).toString());
  });

  it("refuses borrow when price is older than max_price_age", async () => {
    // Price published 61 seconds ago (max_price_age is 60)
    await env.setPrices([150, 1], [1, 0.001], MAX_PRICE_AGE + 1);
    await deposit(env, oneToken().muln(10));

    await catchError(
      borrow(env, oneToken().muln(500)),
      "StalePrice",
      "0x1772",
    );
  });

  it("refuses liquidate when price is older than max_price_age", async () => {
    // Initial active borrow
    await env.setPrices([100, 1], [1, 0.001]);
    await deposit(env, oneToken().muln(10));
    await borrow(env, oneToken().muln(700));

    // Stale price
    await env.setPrices([50, 1], [1, 0.001], MAX_PRICE_AGE + 1);
    await catchError(
      liquidate(env, env.payer.publicKey),
      "StalePrice",
      "0x1772",
    );
  });

  it("refuses borrow when wide confidence band pushes worst-case valuation over limit", async () => {
    // Collateral price is 150, but with a wide confidence band of 40:
    // low end = 150 - 40 = 110 USD.
    // 10 tokens * 110 USD = 1,100 USD worst-case collateral.
    // Borrow LTV = 75% -> max borrow = 825 USD.
    // Attempting to borrow 1,000 USD (which would succeed with conf = 1) must be refused.
    await env.setPrices([150, 40], [1, 0.001]);
    await deposit(env, oneToken().muln(10));

    await catchError(
      borrow(env, oneToken().muln(1_000)),
      "BorrowLimitExceeded",
      "0x1774",
    );
  });

  it("refuses to borrow against a short price spike until it has lasted", async () => {
    // 1. Initial market state with collateral at 150 USD
    await env.setPrices([150, 1], [1, 0.001]);
    await deposit(env, oneToken().muln(10));
    await borrow(env, oneToken().muln(500));

    // Market's moving average is now established around 150 USD.
    // 2. Sudden price spike to 300 USD (doubles instantly)
    await env.setPrices([300, 1], [1, 0.001]);

    // If evaluated at spot 300, 10 tokens would support up to ~2,242 USD debt.
    // But the moving average protects the market: it refuses to lend against the unconfirmed spike.
    // Trying to borrow 1,000 more (total debt 1,500 > max borrow of ~1,117 at 150 USD) fails.
    await catchError(
      borrow(env, oneToken().muln(1_000)),
      "BorrowLimitExceeded",
      "0x1774",
    );

    // 3. Advance time by 301 seconds (past AVERAGE_WINDOW_SECONDS = 300) while price remains 300
    const now = await getTime(env.context);
    await timeTravel(env.context, now + 301n);
    await env.setPrices([300, 1], [1, 0.001]);

    // Now the price spike has lasted for the full window and is accepted by the market average.
    // Borrowing the additional 600 debt tokens now succeeds.
    await borrow(env, oneToken().muln(600));

    const position = await env.program.account.position.fetch(
      env.position(env.payer.publicKey),
    );
    assert.equal(position.debt.toString(), oneToken().muln(1_100).toString());
  });

  it("a position between the two lines cannot borrow more but cannot be liquidated", async () => {
    // borrow_ltv_bps = 75% (7500), liquidation_ltv_bps = 85% (8500)
    await env.setPrices([100, 0.1], [1, 0.001]);
    await deposit(env, oneToken().muln(10)); // Collateral = 10 * 99.9 = 999 USD

    // Max borrow at 75% = 749.25 USD -> borrow 740 debt tokens
    await borrow(env, oneToken().muln(740));

    // Price drops slightly to 90 USD (collateral value = 10 * 89.9 = 899 USD).
    // Debt value = 740 * 1.001 = 740.74 USD.
    // LTV = 740.74 / 899 ≈ 82.4% (between 75% borrow line and 85% liquidation line).
    await env.setPrices([90, 0.1], [1, 0.001]);

    // Cannot borrow more because 82.4% > 75%
    await catchError(
      borrow(env, oneToken().muln(1)),
      "BorrowLimitExceeded",
      "0x1774",
    );

    // Cannot be liquidated because 82.4% <= 85%
    await catchError(
      liquidate(env, env.payer.publicKey),
      "PositionHealthy",
      "0x1775",
    );
  });

  it("liquidates an unhealthy position when LTV exceeds liquidation_ltv_bps", async () => {
    await env.setPrices([100, 0.1], [1, 0.001]);
    await deposit(env, oneToken().muln(10));
    await borrow(env, oneToken().muln(740));

    // Price drops significantly to 80 USD (collateral value = 10 * 79.9 = 799 USD).
    // Debt value = 740.74 USD.
    // LTV = 740.74 / 799 ≈ 92.7% > 85% liquidation line!
    await env.setPrices([80, 0.1], [1, 0.001]);

    const liquidatorCollateralBefore = await tokenBalance(
      env.context,
      env.liquidatorCollateral,
    );
    const liquidatorDebtBefore = await tokenBalance(
      env.context,
      env.liquidatorDebt,
    );

    // Liquidator liquidates the position
    await liquidate(env, env.payer.publicKey);

    const liquidatorCollateralAfter = await tokenBalance(
      env.context,
      env.liquidatorCollateral,
    );
    const liquidatorDebtAfter = await tokenBalance(
      env.context,
      env.liquidatorDebt,
    );

    // Liquidator received all 10 collateral tokens
    assert.equal(
      (liquidatorCollateralAfter - liquidatorCollateralBefore).toString(),
      oneToken().muln(10).toString(),
    );
    // Liquidator repaid 740 debt tokens
    assert.equal(
      (liquidatorDebtBefore - liquidatorDebtAfter).toString(),
      oneToken().muln(740).toString(),
    );

    // Position is cleared
    const position = await env.program.account.position.fetch(
      env.position(env.payer.publicKey),
    );
    assert.equal(position.collateral.toString(), "0");
    assert.equal(position.debt.toString(), "0");
  });
});
