import { BN } from "@coral-xyz/anchor";
import {
  Ed25519Program,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { sendIxs } from "../helpers";
import { ClaimsFixture } from "./fixture";

/** The message the oracle signs: device (32 bytes), total as u64 LE (8 bytes). */
export const claimMessage = (device: PublicKey, total: BN) =>
  Buffer.concat([device.toBuffer(), total.toArrayLike(Buffer, "le", 8)]);

export const claim = async (
  env: ClaimsFixture,
  total: BN,
  caller: Keypair = env.payer,
  signer: Keypair = env.oracle,
  instructions: PublicKey = SYSVAR_INSTRUCTIONS_PUBKEY,
  customMessage?: Buffer,
) => {
  const message = customMessage ?? claimMessage(env.device, total);
  const signatureCheck = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: signer.secretKey,
    message,
  });
  const ix = await env.program.methods
    .claim(total)
    .accountsPartial({
      caller: caller.publicKey,
      device: env.device,
      mint: env.mint,
      ownerTokens: env.ownerTokens,
      instructions,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  await sendIxs(env.context, [caller], signatureCheck, ix);
};
