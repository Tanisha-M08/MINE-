import { BN, Program } from "@coral-xyz/anchor";
import { ProgramTestContext } from "solana-bankrun";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import { RoundExit } from "../../target/types/round_exit";
import idl from "../../target/idl/round_exit.json";
import {
  createMintAndFund,
  findPDA,
  initBankrun,
  oneToken,
  processTransaction,
  sendIxs,
} from "../helpers";

export interface Player {
  keypair: Keypair;
  tokens: PublicKey;
}

export interface RoundFixture {
  context: ProgramTestContext;
  program: Program<RoundExit>;
  payer: Keypair;
  executor: Keypair;
  config: PublicKey;
  vault: PublicKey;
  mint: PublicKey;
  players: Player[];
  round: (id: number) => PublicKey;
  entry: (round: PublicKey, player: PublicKey) => PublicKey;
}

export const setupRounds = async (): Promise<RoundFixture> => {
  idl.metadata.name = "round_exit";
  const { context, program, accounts } = await initBankrun(idl as RoundExit);
  const payer = context.payer;
  const executor = accounts[0];

  const config = findPDA(["config"], program)[0];
  const vault = findPDA(["vault"], program)[0];
  const { mint, ata: payerTokens } = await createMintAndFund(
    context,
    payer,
    payer.publicKey,
    oneToken().muln(1_000_000),
  );

  const players: Player[] = accounts.slice(1, 4).map((keypair) => ({
    keypair,
    tokens: getAssociatedTokenAddressSync(mint, keypair.publicKey),
  }));
  const fund = new Transaction();
  for (const player of players) {
    fund.add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        player.tokens,
        player.keypair.publicKey,
        mint,
      ),
      createTransferInstruction(
        payerTokens,
        player.tokens,
        payer.publicKey,
        BigInt(oneToken().muln(1_000).toString()),
      ),
    );
  }
  await processTransaction(context, fund, [payer]);

  const initIx = await program.methods
    .initialize(executor.publicKey)
    .accountsPartial({
      admin: payer.publicKey,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  await sendIxs(context, [payer], initIx);

  const round = (id: number) =>
    findPDA(["round", new BN(id).toArrayLike(Buffer, "le", 8)], program)[0];
  const entry = (roundKey: PublicKey, player: PublicKey) =>
    findPDA(["entry", roundKey, player], program)[0];

  return {
    context,
    program,
    payer,
    executor,
    config,
    vault,
    mint,
    players,
    round,
    entry,
  };
};
