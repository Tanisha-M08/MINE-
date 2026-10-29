# Solution

## Which end of the band each value uses

### In `borrow`:
- **Collateral:** Uses the **low end** of the Pyth band (`price - conf`), capped by the market's internal time-weighted average: $\min(\text{collateral\_band.low}, \text{market.collateral\_price\_average})$.
  - *Why:* When extending new debt against collateral, the protocol must practice defensive computation and assume the collateral is worth the minimum possible value within the oracle's uncertainty band. Overvaluing collateral would allow borrowers to take on undercollateralized loans that leave unbacked bad debt.
- **Debt:** Uses the **high end** of the Pyth band (`price + conf`).
  - *Why:* The protocol assumes the borrowed asset is at the highest end of its uncertainty band. Undervaluing the debt token would allow users to extract more purchasing power than their collateral safely covers.

### In `liquidate`:
- **Collateral:** Uses the **low end** of the Pyth band (`price - conf`) from spot prices directly.
  - *Why:* The protocol must evaluate solvency at the worst-case valuation. If collateral is worth the lower bound of the oracle confidence interval and puts the position over the liquidation threshold, the protocol is in imminent danger of bad debt and must allow liquidators to unwind the position immediately.
- **Debt:** Uses the **high end** of the Pyth band (`price + conf`).
  - *Why:* The outstanding liability is valued at its maximum possible cost, ensuring undercollateralized accounts are flagged and resolved before market slippage causes insolvency.

## The two lines

### Why the borrow line is stricter than the liquidation line
- The **borrow line** (`borrow_ltv_bps = 75%`) defines the maximum leverage a user can voluntarily take on when opening or increasing a loan.
- The **liquidation line** (`liquidation_ltv_bps = 85%`) defines the boundary where a position becomes dangerously risky and is subject to forced liquidation.
- The difference between the two lines creates a **10% safety buffer**. If borrowing were allowed right up to the liquidation threshold, ordinary oracle jitter, confidence spread, or micro-fluctuations in price would instantly make newly opened positions liquidatable on the very next slot. The buffer provides a zone of tolerance where healthy positions can fluctuate without triggering unnecessary liquidations.

### Which checks `borrow` makes that `liquidate` does not, and why liquidation must not inherit them
1. **LTV Threshold**: `borrow` requires $\text{LTV} \le 75\%$, whereas `liquidate` triggers only when $\text{LTV} > 85\%$.
   - *Why:* A liquidation is an emergency recovery action. If `liquidate` inherited the 75% borrow limit, positions sitting safely in the buffer (e.g. at 80% LTV) would be unjustly seized and liquidated, harming borrowers and draining protocol trust.
2. **Time-Weighted Moving Average**: `borrow` caps collateral price at the market's internal 5-minute average ($\min(\text{spot\_low}, \text{average})$) to prevent borrowing against sudden price jumps. `liquidate` uses the **spot** price band directly without the average.
   - *Why:* When collateral crashes on the spot market, the position is immediately at risk. If `liquidate` were forced to wait for the 5-minute average to slowly decline, the position could become deeply insolvent before liquidators are allowed to step in. Liquidation must act on current market reality with zero delay.

## The value from the market's own state

### What the market keeps in its account, and how it is updated
- The `Market` account stores:
  - `pub collateral_price_average: u64`: The rolling time-weighted average of the collateral midpoint price (in USD with 6 decimals).
  - `pub last_update_time: i64`: The unix timestamp of the last price observation.
- **Update Rule**: Whenever an instruction reads the collateral price (`borrow` or `liquidate`), it updates the average across the window $W = 300\text{ seconds}$ (5 minutes):
  $$\Delta t = \min(\text{now} - \text{last\_update\_time}, W)$$
  $$\text{new\_avg} = \frac{\text{prev\_avg} \times (W - \Delta t) + \text{current\_mid\_price} \times \Delta t}{W}$$

### Which instruction uses it, and why not the others
- **`borrow` uses it:** To prevent users from borrowing against unconfirmed, short-lived price spikes (e.g. temporary market pumps or oracle manipulation).
- **`liquidate` does not use it:** Liquidations must be fail-fast; delaying liquidations until an average catches up would produce bad debt during market crashes.
- **`deposit` does not use it:** Deposits only transfer collateral tokens into the vault; they do not calculate position leverage or issue debt liabilities, so no price evaluation is needed.

### What happens during a short price spike, and what happens when the price really falls
- **During a short price spike:** If the collateral spot price suddenly jumps (e.g. from \$150 to \$300), the 5-minute average barely changes over a few seconds. `borrow` values collateral at $\min(\text{spot\_low}, \text{average}) = \min(299, 150) = 150$. Borrowing against the spike is rejected until the higher price has persisted for the full window.
- **When the price really falls:** If the spot price drops (e.g. from \$150 to \$80), $\text{spot\_low}$ drops immediately to ~\$80 while the average remains high (~\$150). Because `borrow` takes $\min(\text{spot\_low}, \text{average}) = \min(80, 150) = 80$, borrowing power is immediately slashed. The market values collateral at its worst in both directions.

## A price that is too old

### What the program does with a price older than `max_price_age`
The program calls Pyth's `get_price_no_older_than(clock, max_price_age, feed_id)`. If the published price is older than `max_price_age` (60 seconds), the instruction fails fast with `MarketError::StalePrice`. The program strictly refuses to issue loans or execute liquidations on stale data.

### Who can fix it
**Anyone.** Pyth uses a Pull Oracle model. Any party—whether the user trying to borrow, a liquidator wanting to liquidate, or an automated keeper/crank—can retrieve the latest cryptographic price update from the off-chain Pyth Hermes service and prepend a Pyth receiver update instruction to their transaction. This updates the on-chain `PriceUpdateV2` account atomically in the same transaction right before `borrow` or `liquidate` executes.
