# Solution

## The two numbers

The pool and stakers avoid looping by decomposing reward tracking into two numbers: a global accumulator and a local checkpoint.

1. **The Pool stores:**
   - `total_staked: u64`: The total token amount currently staked across all participants.
   - `reward_per_token: u128`: A monotonically increasing accumulator tracking cumulative rewards earned per staked token unit since pool inception, scaled by a fixed-point precision factor (`PRECISION = 10^18`).
   - When a reward of amount $R$ arrives, the pool updates:
     $$\text{pool.reward\_per\_token} \mathrel{+}= \frac{R \times \text{PRECISION}}{\text{pool.total\_staked}}$$

2. **Each Staker stores:**
   - `stake: u64`: The staker's currently deposited active stake.
   - `reward_per_token: u128`: A checkpoint recording the value of `pool.reward_per_token` at the time of the staker's last settlement.
   - `pending: u64`: Accrued rewards earned during prior staking intervals that have been settled but not yet claimed.

3. **Formula for what a staker is owed:**
   When settling a staker:
   $$\Delta = \text{pool.reward\_per\_token} - \text{staker.reward\_per\_token}$$
   $$\text{earned} = \frac{\text{staker.stake} \times \Delta}{\text{PRECISION}}$$
   $$\text{total\_owed} = \text{staker.pending} + \text{earned}$$
   Upon settlement, `staker.pending += earned` and `staker.reward_per_token = pool.reward_per_token`.

## Settle first

`stake` and `unstake` must settle what the staker is owed before modifying `staker.stake` or `pool.total_staked` because the reward rate $\Delta$ accumulated between the previous checkpoint and the current moment applies strictly to the stake that was at risk in the pool during that elapsed period.

### Numerical demonstration:
Assume Alice has 100 tokens staked in a pool with 200 total staked tokens (a 50% pool share). A reward of 100 tokens arrives. Alice is legitimately entitled to $100 \times 50\% = 50$ tokens. Alice now submits a transaction to deposit 300 additional tokens, increasing her stake to 400.

- **Correct order (Settle First):**
  1. Calculate earned rewards using Alice's *existing* stake (100 tokens):
     $$\text{earned} = 100 \times \Delta = 50\text{ tokens}$$
  2. Lock 50 tokens into `staker.pending` and advance `staker.reward_per_token` to `pool.reward_per_token`.
  3. Increase `staker.stake` from 100 to 400 tokens and `pool.total_staked` from 200 to 500 tokens.
  4. Alice receives her rightful 50 tokens.

- **Incorrect order (Change Stake First):**
  1. Increase `staker.stake` first from 100 to 400 tokens.
  2. Settle against the new stake of 400 tokens:
     $$\text{earned} = 400 \times \Delta = 200\text{ tokens}$$
  3. Alice would be credited 200 tokens out of a 100-token reward, stealing other stakers' earnings.

The same principle holds for `unstake`: if Alice held 300 tokens and unstaked 200 before settling, settling against the remaining 100 tokens would unfairly deprive her of two-thirds of the rewards she accrued while her 300 tokens were actively staked.

## The staker nobody touches

A staker who never claims or interacts with the pool while rewards keep arriving requires zero computation or state updates on-chain. When `add_rewards` is called, no staker account is touched or loaded; only `pool.reward_per_token` increments.

Because the reward-per-token accumulator is linear and cumulative:
$$\sum_{i=1}^n \Delta_i = \text{pool.reward\_per\_token}_{\text{current}} - \text{staker.reward\_per\_token}_{\text{initial}}$$

When the dormant staker finally returns after arbitrary months and intervening transactions by others:
$$\text{earned} = \frac{\text{staker.stake} \times (\text{pool.reward\_per\_token}_{\text{current}} - \text{staker.reward\_per\_token}_{\text{initial}})}{\text{PRECISION}}$$
This closed-form calculation computes the exact mathematical sum of all fractional rewards distributed across every single reward event since the staker's initial deposit, down to the indivisible base unit, without ever needing a loop.

## What lazy loading does not cover

Lazy loading relies entirely on a "pay-as-you-act" paradigm: state is only reconciled when an account owner interacts with their own account. Any action that fundamentally alters total pool dynamics or requires proactive intervention cannot wait for the owner to show up.

1. **Auto-Compounding Rewards:**
   If earned rewards are meant to automatically compound into active stake (so that past rewards earn future rewards), `staker.stake` and `pool.total_staked` must increase. Because changing `pool.total_staked` affects every subsequent reward distribution, compounding cannot be calculated retroactively without tracking the exact timestamp of every compounding event.

2. **Liquidations or Slashing:**
   If a staker's position is subject to liquidation (undercollateralized lending position) or slashing (validator penalty in PoS), the protocol cannot wait for an insolvent or penalized user to voluntarily call the program.

**What the design needs for it:**
It requires an **incentivized keeper/crank mechanism** (untrusted executor). The protocol must expose permissionless instructions that allow third-party bots to trigger the action on behalf of an account, compensating the executor with a small fee or bounty (such as a fraction of the compounded reward or a liquidation penalty) to cover transaction costs and ensure liveness.
