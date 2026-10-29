import { Program } from "@coral-xyz/anchor";
import { ProgramTestContext } from "solana-bankrun";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import { TotalClaims } from "../../target/types/total_claims";
import idl from "../../target/idl/total_claims.json";
import {
  createMintAndFund,
  findPDA,
  initBankrun,
  oneToken,
  processTransaction,
  sendIxs,
} from "../helpers";

export interface ClaimsFixture {
  context: ProgramTestContext;
  program: Program<TotalClaims>;
  payer: Keypair;
  oracle: Keypair;
  owner: Keypair;
  config: PublicKey;
  vault: PublicKey;
  mint: PublicKey;
  device: PublicKey;
  ownerTokens: PublicKey;
}

export const setupClaims = async (): Promise<ClaimsFixture> => {
  idl.metadata.name = "total_claims";
  const { context, program, accounts } = await initBankrun(idl as TotalClaims);
  const payer = context.payer;
  const [oracle, owner] = accounts;

  const config = findPDA(["config"], program)[0];
  const vault = findPDA(["vault"], program)[0];
  const device = findPDA(["device", owner.publicKey], program)[0];
  const { mint, ata: payerTokens } = await createMintAndFund(
    context,
    payer,
    payer.publicKey,
    oneToken().muln(1_000_000),
  );

  const initIx = await program.methods
    .initialize(oracle.publicKey)
    .accountsPartial({
      admin: payer.publicKey,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  await sendIxs(context, [payer], initIx);

  const ownerTokens = getAssociatedTokenAddressSync(mint, owner.publicKey);
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
        ownerTokens,
        owner.publicKey,
        mint,
      ),
    ),
    [payer],
  );

  const registerIx = await program.methods
    .registerDevice()
    .accountsPartial({ owner: owner.publicKey })
    .instruction();
  await sendIxs(context, [owner], registerIx);

  return {
    context,
    program,
    payer,
    oracle,
    owner,
    config,
    vault,
    mint,
    device,
    ownerTokens,
  };
};
