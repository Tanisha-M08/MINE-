use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::{Book, BookError, CELLS, NONE};

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"book"], bump = book.load()?.bump)]
    pub book: AccountLoader<'info, Book>,
    #[account(address = book.load()?.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_tokens: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault"], bump)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Places an order. `hint` is the cell the new order should go after, or `None` for the head.
/// Performs O(1) local neighbor checks without walking the book.
pub fn place_order(
    ctx: Context<PlaceOrder>,
    price: u64,
    size: u64,
    hint: Option<u16>,
) -> Result<()> {
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.owner_tokens.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        size,
        ctx.accounts.mint.decimals,
    )?;

    let mut book = ctx.accounts.book.load_mut()?;

    // 1. Verify the book has capacity
    let cell = book.free_head;
    require!(cell != NONE, BookError::BookFull);

    // 2. Perform local neighbor checks using the hint
    let after = match hint {
        None => {
            // Inserting at the head: book must be empty (head == NONE) or the existing head must be strictly cheaper
            let head = book.head;
            if head != NONE {
                require!((head as usize) < CELLS, BookError::BadHint);
                let head_cell = &book.cells[head as usize];
                require!(
                    head_cell.alive == 1 && head_cell.price < price,
                    BookError::BadHint
                );
            }
            NONE
        }
        Some(h) => {
            // Inserting after cell `h`:
            // - `h` must be a valid, live cell with price >= new order price
            require!((h as usize) < CELLS, BookError::BadHint);
            let hint_cell = &book.cells[h as usize];
            require!(
                hint_cell.alive == 1 && hint_cell.price >= price,
                BookError::BadHint
            );

            // - The cell currently following `h` must be NONE (tail) or alive with price strictly below new price
            let next = hint_cell.next;
            if next != NONE {
                require!((next as usize) < CELLS, BookError::BadHint);
                let next_cell = &book.cells[next as usize];
                require!(
                    next_cell.alive == 1 && next_cell.price < price,
                    BookError::BadHint
                );
            }
            h
        }
    };

    // 3. Allocate free cell and link
    book.free_head = book.cells[cell as usize].next;
    link(
        &mut book,
        cell,
        after,
        ctx.accounts.owner.key(),
        price,
        size,
    );

    Ok(())
}

/// Links `cell` into the list right after `after` (or at the head when `after` is NONE).
pub fn link(book: &mut Book, cell: u16, after: u16, owner: Pubkey, price: u64, size: u64) {
    let next = if after == NONE {
        book.head
    } else {
        book.cells[after as usize].next
    };
    let c = &mut book.cells[cell as usize];
    c.owner = owner;
    c.price = price;
    c.size = size;
    c.prev = after;
    c.next = next;
    c.alive = 1;
    if after == NONE {
        book.head = cell;
    } else {
        book.cells[after as usize].next = cell;
    }
    if next != NONE {
        book.cells[next as usize].prev = cell;
    }
}
