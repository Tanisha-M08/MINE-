# Solution

## The two complexities

What does placing an order cost off-chain, and what does it cost on-chain after your change? Why does the on-chain cost not grow with the book?

- **Off-chain cost:** Off-chain, finding the right insertion slot costs $O(n)$ if the client scans the linked list linearly, or $O(\log n)$ if the client maintains a local balanced search tree (such as an AVL/red-black tree or a skip list) of active orders. Crucially, off-chain computation is practically free and unconstrained by blockchain transaction limits or gas fees.
- **On-chain cost:** On-chain, placing an order costs $O(1)$ constant time and compute. The program only inspects at most two cells (the provided `hint` cell and its successor `hint.next`, or the current `head` cell if `hint == None`). It never walks or iterates over the list.
- **Why on-chain cost does not grow with the book:** This design exploits _complexity asymmetry_. Instead of making the blockchain execute an expensive $O(n)$ linear traversal across an unbounded or large list, the searching burden is shifted to the off-chain client, leaving the on-chain program only the task of verification. Because verifying the local sorted order invariants requires checking only the candidate's immediate predecessor (`hint`) and successor (`hint.next`), the number of memory reads and comparisons is constant, regardless of whether the order book contains 1 order or 10,000 orders.

## The checks

List the comparisons `place_order` makes, and say which wrong hint each one catches.

1. **`h < CELLS` (predecessor bounds check):**
   - Catches invalid cell indices that exceed the fixed array bounds (`h >= 64`), preventing array index out-of-bounds panics.

2. **`hint_cell.alive == 1` (predecessor liveness check):**
   - Catches hints pointing to unallocated slots on the free list or orders that have already been cancelled and freed.

3. **`hint_cell.price >= new_price` (predecessor price check):**
   - Catches hints pointing to an order that is cheaper than the new order. Orders must be ordered from highest to lowest price (with older orders at the same price remaining in front), so the predecessor must have a price greater than or equal to the new order.

4. **`next_cell.alive == 1` (successor liveness check, if `hint_cell.next != NONE`):**
   - Catches corrupted or invalid next pointers in the linked list.

5. **`next_cell.price < new_price` (successor price check, if `hint_cell.next != NONE`):**
   - Catches wrong hints that skip over intermediate orders (where the new order should have been placed further down the list).
   - Catches **stale hints**: if another user's transaction landed first and inserted an order between `hint` and its former successor with a price greater than or equal to `new_price`, `hint.next` is no longer cheaper than `new_price`, causing the transaction to fail safely with `BookError::BadHint`.

6. **`head_cell.alive == 1 && head_cell.price < new_price` (head insertion check, if `hint == None` and `head != NONE`):**
   - Catches `None` hints when the order is not actually the highest price in the book (the existing head is more expensive or equal in price).
   - Catches stale `None` hints where another higher-priced order was inserted at the head before this transaction executed.

## The fixed capacity

Why is the number of cells fixed? What could an attacker do with a book whose placement cost grows with its size, and what stops them from filling this one for free?

- **Why the number of cells is fixed:**
  - Fixed-size storage allows the `Book` data structure (`cells: [Cell; 64]`) to have a static, predictable memory footprint. This enables zero-copy deserialization (`ctx.accounts.book.load_mut()?`) without dynamic heap allocations or costly account reallocations (`realloc`).
  - It ensures predictable rent-exemption lamport requirements and eliminates memory fragmentation or runtime resizing failures on-chain.

- **What an attacker could do if placement cost grew with size:**
  - In the original $O(n)$ implementation, placing an order walked the linked list starting from the head. An attacker could flood the book with low-value orders, lengthening the linked list traversal. As $n$ grew, transactions attempting to place orders would consume an increasing number of compute units until exceeding Solana's transaction compute unit limit (200k or 1.4M CUs). At that point, placing new orders would become impossible, effectively bricking the order book and causing a permanent Denial of Service (DoS).

- **What stops them from filling this one for free:**
  - Every order placement requires calling `transfer_checked` to deposit and lock `size` tokens into the program's vault account. An attacker cannot fill cells for free; every cell occupied locks real economic capital.
  - Furthermore, because order placement is $O(1)$, an attacker cannot increase the compute cost or latency for other participants by filling the book. If the book runs out of cells, it cleanly rejects further orders with `BookError::BookFull`, and genuine traders can cancel their orders anytime via `cancel_order` to free cells and recover their locked collateral.
