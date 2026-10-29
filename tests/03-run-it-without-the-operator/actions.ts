import { BN } from "@coral-xyz/anchor";
import {
  Ed25519Program,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { getTime, sendIxs } from "../helpers";
import { RewardsFixture } from "./fixture";

export const accrue = async (
  env: RewardsFixture,
  owner: PublicKey,
  amount: BN,
) => {
  const ix = await env.program.methods
    .accrue(amount)
    .accountsPartial({ admin: env.payer.publicKey, owner })
    .instruction();
  await sendIxs(env.context, [env.payer], ix);
};

export const claim = async (
  env: RewardsFixture,
  caller: Keypair,
  owner: PublicKey,
  ownerTokens: PublicKey,
  callerTokens: PublicKey,
) => {
  const ix = await env.program.methods
    .claim()
    .accountsPartial({
      caller: caller.publicKey,
      user: env.userAccount(owner),
      mint: env.mint,
      userTokens: ownerTokens,
      callerTokens,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  await sendIxs(env.context, [caller], ix);
};

export const priceMessage = (price: BN, timestamp: number | bigint): Buffer => {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64LE(BigInt(price.toString()), 0);
  buf.writeBigInt64LE(BigInt(timestamp.toString()), 8);
  return buf;
};

export const setPrice = async (
  env: RewardsFixture,
  price: BN,
  signer: Keypair = env.stranger,
  oracle: Keypair = env.oracle,
  timestamp?: number | bigint,
  instructions: PublicKey = SYSVAR_INSTRUCTIONS_PUBKEY,
  messageOverride?: Buffer,
) => {
  const time = timestamp ?? (await getTime(env.context));
  const message = messageOverride ?? priceMessage(price, time);
  const signatureCheck = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: oracle.secretKey,
    message,
  });
  const ix = await env.program.methods
    .setPrice(price)
    .accountsPartial({
      caller: signer.publicKey,
      instructions,
    })
    .instruction();
  await sendIxs(env.context, [signer], signatureCheck, ix);
};

export const buy = async (
  env: RewardsFixture,
  buyer: Keypair,
  buyerTokens: PublicKey,
  lamports: BN,
) => {
  const ix = await env.program.methods
    .buy(lamports)
    .accountsPartial({
      buyer: buyer.publicKey,
      mint: env.mint,
      buyerTokens,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  await sendIxs(env.context, [buyer], ix);
};
