import * as anchor from "@coral-xyz/anchor";
import { Idl, Program } from "@coral-xyz/anchor";
import { BankrunProvider } from "anchor-bankrun";
import { resolve } from "path";
import { AddedAccount, Clock, ProgramTestContext, start } from "solana-bankrun";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Signer,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

export const initBankrun = async <IDL extends Idl>(idl: IDL) => {
  const accounts: Keypair[] = [];
  const accountsToInject: AddedAccount[] = [];

  for (let i = 0; i < 10; i++) {
    const keypair = Keypair.generate();
    accounts.push(keypair);

    accountsToInject.push({
      address: keypair.publicKey,
      info: {
        lamports: 1000 * LAMPORTS_PER_SOL,
        data: Buffer.alloc(0),
        owner: SystemProgram.programId,
        executable: false,
        rentEpoch: 0,
      },
    });
  }

  const deployDir = resolve("target/deploy");
  process.env.SBF_OUT_DIR = process.env.SBF_OUT_DIR ?? deployDir;
  process.env.BPF_OUT_DIR = process.env.BPF_OUT_DIR ?? deployDir;

  const name = (idl as { metadata?: { name?: string } }).metadata?.name;
  const address = (idl as { address?: string }).address;
  if (!name || !address) {
    throw new Error("IDL is missing metadata.name or address");
  }

  const context = await start(
    [{ name, programId: new PublicKey(address) }],
    accountsToInject,
  );
  const provider = new BankrunProvider(context);
  anchor.setProvider(provider);

  const program = new Program<IDL>(idl, provider);

  return { context, provider, accounts, program };
};

let latestSlot = 1;

export const processTransaction = async (
  ctx: ProgramTestContext,
  transaction: Transaction,
  signers: (Keypair | Signer)[],
) => {
  ctx.warpToSlot(BigInt(latestSlot + 1));
  latestSlot++;

  transaction.recentBlockhash = ctx.lastBlockhash;
  transaction.feePayer = signers[0].publicKey;
  transaction.sign(...signers);

  await ctx.banksClient.processTransaction(transaction);
};

export const sendIxs = (
  ctx: ProgramTestContext,
  signers: Keypair[],
  ...instructions: TransactionInstruction[]
) => processTransaction(ctx, new Transaction().add(...instructions), signers);

export const simulateReturnData = async (
  ctx: ProgramTestContext,
  signers: Keypair[],
  instructions: TransactionInstruction[],
): Promise<Buffer> => {
  ctx.warpToSlot(BigInt(latestSlot + 1));
  latestSlot++;

  const tx = new Transaction();
  tx.recentBlockhash = ctx.lastBlockhash;
  tx.feePayer = signers[0].publicKey;
  tx.add(...instructions);
  tx.sign(...signers);

  const result = await ctx.banksClient.simulateTransaction(tx);
  const data = result.meta?.returnData?.data;
  if (!data) throw new Error("simulation produced no return data");
  return Buffer.from(data);
};

export const timeTravel = async (ctx: ProgramTestContext, timestamp: bigint) => {
  const clock = await ctx.banksClient.getClock();
  ctx.setClock(
    new Clock(
      clock.slot,
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      timestamp,
    ),
  );
};

export const getTime = async (ctx: ProgramTestContext) =>
  (await ctx.banksClient.getClock()).unixTimestamp;
