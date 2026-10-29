import { BN, Program } from "@coral-xyz/anchor";
import { ProgramTestContext } from "solana-bankrun";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import { OperatorFree } from "../../target/types/operator_free";
import idl from "../../target/idl/operator_free.json";
import {
  createMintAndFund,
  findPDA,
  initBankrun,
  oneToken,
  processTransaction,
  sendIxs,
} from "../helpers";

export const MAX_PRICE_AGE = 60;

export interface RewardsFixture {
  context: ProgramTestContext;
  program: Program<OperatorFree>;
  payer: Keypair;
  bot: Keypair;
  oracle: Keypair;
  user: Keypair;
  stranger: Keypair;
  config: PublicKey;
  vault: PublicKey;
  mint: PublicKey;
  userTokens: PublicKey;
  strangerTokens: PublicKey;
  userAccount: (owner: PublicKey) => PublicKey;
}

export const setupRewards = async (): Promise<RewardsFixture> => {
  const { context, program, accounts } = await initBankrun(idl as OperatorFree);
  const payer = context.payer;
  const [bot, oracle, user, stranger] = accounts;

  const config = findPDA(["config"], program)[0];
  const vault = findPDA(["vault"], program)[0];
  const { mint, ata: payerTokens } = await createMintAndFund(
    context,
    payer,
    payer.publicKey,
    oneToken().muln(1_000_000),
  );

  const initIx = await program.methods
    .initialize(oracle.publicKey, new BN(MAX_PRICE_AGE))
    .accountsPartial({
      admin: payer.publicKey,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  await sendIxs(context, [payer], initIx);

  const userTokens = getAssociatedTokenAddressSync(mint, user.publicKey);
  const strangerTokens = getAssociatedTokenAddressSync(
    mint,
    stranger.publicKey,
  );
  await processTransaction(
    context,
    new Transaction().add(
      createTransferInstruction(
        payerTokens,
        vault,
        payer.publicKey,
        BigInt(oneToken().muln(100_000).toString()),
      ),
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        userTokens,
        user.publicKey,
        mint,
      ),
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        strangerTokens,
        stranger.publicKey,
        mint,
      ),
    ),
    [payer],
  );

  const userAccount = (owner: PublicKey) =>
    findPDA(["user", owner], program)[0];

  return {
    context,
    program,
    payer,
    bot,
    oracle,
    user,
    stranger,
    config,
    vault,
    mint,
    userTokens,
    strangerTokens,
    userAccount,
  };
};
