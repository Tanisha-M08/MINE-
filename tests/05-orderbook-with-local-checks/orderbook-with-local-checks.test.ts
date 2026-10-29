import { assert } from "chai";

import { oneToken, toBN, tokenBalance } from "../helpers";
import { BookFixture, findHint, listOrders, setupBook } from "./fixture";
import { cancelOrder, placeOrder } from "./actions";

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
  assert.isNotNull(
    err,
    `Instruction must fail with ${expectedName} (${expectedHex})`,
  );
  const errStr = err!.toString();
  const matched = errStr.includes(expectedName) || errStr.includes(expectedHex);
  assert.isTrue(
    matched,
    `Error "${errStr}" must contain either "${expectedName}" or "${expectedHex}"`,
  );
};

describe("05-orderbook-with-local-checks", () => {
  let env: BookFixture;

  beforeEach(async () => {
    env = await setupBook();
  });

  it("keeps the orders sorted from the highest price to the lowest", async () => {
    const [alice, bob, carol] = env.traders;
    for (const [trader, price] of [
      [alice, 10],
      [bob, 30],
      [carol, 20],
    ] as const) {
      const hint = findHint(await env.readBook(), toBN(price));
      await placeOrder(env, trader, toBN(price), oneToken(), hint);
    }

    const book = await env.readBook();
    const prices = listOrders(book).map((cell) =>
      book.cells[cell].price.toNumber(),
    );
    assert.deepEqual(prices, [30, 20, 10]);
    assert.equal(
      (await tokenBalance(env.context, env.vault)).toString(),
      oneToken().muln(3).toString(),
    );

    const bobsCell = listOrders(book)[0];
    await cancelOrder(env, bob, bobsCell);
    const after = await env.readBook();
    assert.deepEqual(
      listOrders(after).map((cell) => after.cells[cell].price.toNumber()),
      [20, 10],
    );
  });

  it("inserts correctly at the head, in the middle, and at the tail", async () => {
    const [alice, bob, carol] = env.traders;

    // 1. First order in empty book (head)
    let book = await env.readBook();
    await placeOrder(
      env,
      alice,
      toBN(50),
      oneToken(),
      findHint(book, toBN(50)),
    ); // hint: null

    // 2. Insert higher price (new head)
    book = await env.readBook();
    await placeOrder(env, bob, toBN(70), oneToken(), findHint(book, toBN(70))); // hint: null

    // 3. Insert lower price (tail)
    book = await env.readBook();
    const tailHint = findHint(book, toBN(30)); // hint: cell with price 50
    assert.isNotNull(tailHint);
    await placeOrder(env, carol, toBN(30), oneToken(), tailHint);

    // 4. Insert middle prices
    book = await env.readBook();
    await placeOrder(
      env,
      alice,
      toBN(60),
      oneToken(),
      findHint(book, toBN(60)),
    ); // between 70 and 50

    book = await env.readBook();
    await placeOrder(env, bob, toBN(40), oneToken(), findHint(book, toBN(40))); // between 50 and 30

    // Verify ordering: [70, 60, 50, 40, 30]
    book = await env.readBook();
    const prices = listOrders(book).map((cell) =>
      book.cells[cell].price.toNumber(),
    );
    assert.deepEqual(prices, [70, 60, 50, 40, 30]);
  });

  it("refuses an invalid/wrong hint", async () => {
    const [alice, bob] = env.traders;

    // Place [70, 50, 30]
    await placeOrder(env, alice, toBN(70), oneToken(), null);
    let book = await env.readBook();
    await placeOrder(
      env,
      alice,
      toBN(50),
      oneToken(),
      findHint(book, toBN(50)),
    );
    book = await env.readBook();
    await placeOrder(
      env,
      alice,
      toBN(30),
      oneToken(),
      findHint(book, toBN(30)),
    );

    book = await env.readBook();
    const cell70 = listOrders(book)[0];
    const cell50 = listOrders(book)[1];
    const cell30 = listOrders(book)[2];

    // Try placing 40 at the head (hint: null) when head price is 70 => rejected
    await catchError(
      placeOrder(env, bob, toBN(40), oneToken(), null),
      "BadHint",
      "0x1775",
    );

    // Try placing 40 after cell30 (hint price 30 < 40) => rejected
    await catchError(
      placeOrder(env, bob, toBN(40), oneToken(), cell30),
      "BadHint",
      "0x1775",
    );

    // Try placing 60 after cell50 (hint price 50 < 60) => rejected
    await catchError(
      placeOrder(env, bob, toBN(60), oneToken(), cell50),
      "BadHint",
      "0x1775",
    );

    // Try placing 60 after cell70 when next is 50 (valid would be cell70)
    // but try placing 80 after cell70 (hint price 70 < 80) => rejected
    await catchError(
      placeOrder(env, bob, toBN(80), oneToken(), cell70),
      "BadHint",
      "0x1775",
    );
  });

  it("refuses a hint that went stale after another insertion landed first", async () => {
    const [alice, bob, carol] = env.traders;

    // Start with [70, 30]
    await placeOrder(env, alice, toBN(70), oneToken(), null);
    let book = await env.readBook();
    await placeOrder(
      env,
      alice,
      toBN(30),
      oneToken(),
      findHint(book, toBN(30)),
    );

    book = await env.readBook();
    const cell70 = listOrders(book)[0];

    // Carol prepares to place order at price 40.
    // Her hint is cell70 (whose next is currently cell30 with price 30 < 40)
    const carolsHint = findHint(book, toBN(40));
    assert.equal(carolsHint, cell70);

    // Meanwhile, Bob's transaction lands first with price 50 (hint: cell70)
    await placeOrder(env, bob, toBN(50), oneToken(), cell70);

    // Now the book is [70, 50, 30]. cell70's next is Bob's cell (price 50).
    // Carol submits her transaction with the now-stale hint (cell70)
    // Because next cell price (50) is NOT < Carol's price (40), it must be refused!
    await catchError(
      placeOrder(env, carol, toBN(40), oneToken(), carolsHint),
      "BadHint",
      "0x1775",
    );
  });

  it("cancels an order in the middle, relinks neighbors, and reuses the freed cell", async () => {
    const [alice, bob, carol] = env.traders;

    // Place [70, 50, 30]
    await placeOrder(env, alice, toBN(70), oneToken(), null);
    let book = await env.readBook();
    await placeOrder(env, bob, toBN(50), oneToken(), findHint(book, toBN(50)));
    book = await env.readBook();
    await placeOrder(
      env,
      carol,
      toBN(30),
      oneToken(),
      findHint(book, toBN(30)),
    );

    book = await env.readBook();
    const cell70 = listOrders(book)[0];
    const cell50 = listOrders(book)[1];
    const cell30 = listOrders(book)[2];

    const bobsBalanceBefore = await tokenBalance(env.context, bob.tokens);

    // Bob cancels order at price 50 (middle)
    await cancelOrder(env, bob, cell50);

    const bobsBalanceAfter = await tokenBalance(env.context, bob.tokens);
    assert.equal(
      (bobsBalanceAfter - bobsBalanceBefore).toString(),
      oneToken().toString(),
      "Bob received his locked tokens back",
    );

    // Verify relinking: cell70 next is cell30, cell30 prev is cell70
    book = await env.readBook();
    assert.equal(book.cells[cell70].next, cell30);
    assert.equal(book.cells[cell30].prev, cell70);
    assert.equal(book.cells[cell50].alive, 0);
    assert.equal(book.freeHead, cell50, "cell50 is now head of free list");

    // Place a new order at price 60. It must reuse cell50!
    await placeOrder(
      env,
      alice,
      toBN(60),
      oneToken(),
      findHint(book, toBN(60)),
    );
    book = await env.readBook();

    assert.equal(book.cells[cell50].alive, 1);
    assert.equal(book.cells[cell50].price.toNumber(), 60);

    const prices = listOrders(book).map((cell) =>
      book.cells[cell].price.toNumber(),
    );
    assert.deepEqual(prices, [70, 60, 30]);
  });

  it("refuses to place an order when the book is full", async () => {
    const [alice] = env.traders;

    // Fill all 64 cells with descending prices
    for (let i = 0; i < 64; i++) {
      const price = 1000 - i;
      const hint = i === 0 ? null : i - 1;
      await placeOrder(env, alice, toBN(price), toBN(10), hint);
    }

    const book = await env.readBook();
    assert.equal(listOrders(book).length, 64);
    assert.equal(book.freeHead, 65535, "Free list is empty");

    // Attempting to place the 65th order fails with BookFull
    await catchError(
      placeOrder(env, alice, toBN(1), toBN(10), 63),
      "BookFull",
      "0x1771",
    );
  });
});
