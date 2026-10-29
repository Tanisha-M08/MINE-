import { BN, Program } from "@coral-xyz/anchor";
import { ProgramTestContext } from "solana-bankrun";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { randomBytes } from "crypto";

import { PositionValue } from "../../target/types/position_value";
import idl from "../../target/idl/position_value.json";
import {
  createMintAndFund,
  findPDA,
  getTime,
  initBankrun,
  oneToken,
  processTransaction,
  sendIxs,
  setPythPrice,
} from "../helpers";

export const MAX_PRICE_AGE = 60;
export const BORROW_LTV_BPS = 7_500;
export const LIQUIDATION_LTV_BPS = 8_500;

export interface MarketFixture {
  context: ProgramTestContext;
  program: Program<PositionValue>;
  payer: Keypair;
  liquidator: Keypair;
  market: PublicKey;
  collateralMint: PublicKey;
  debtMint: PublicKey;
  collateralVault: PublicKey;
  debtVault: PublicKey;
  payerCollateral: PublicKey;
  payerDebt: PublicKey;
  liquidatorCollateral: PublicKey;
  liquidatorDebt: PublicKey;
  collateralFeed: Buffer;
  debtFeed: Buffer;
  collateralPrice: PublicKey;
  debtPrice: PublicKey;
  position: (owner: PublicKey) => PublicKey;
  setPrices: (collateral: [number, number], debt: [number, number], age?: number) => Promise<void>;
}

export const setupMarket = async (): Promise<MarketFixture> => {
  idl.metadata.name = "position_value";
  const { context, program, accounts } = await initBankrun(idl as PositionValue);
  const payer = context.payer;
  const liquidator = accounts[0];

  const market = findPDA(["market"], program)[0];
  const collateralVault = findPDA(["collateral_vault"], program)[0];
  const debtVault = findPDA(["debt_vault"], program)[0];

  const { mint: collateralMint, ata: payerCollateral } = await createMintAndFund(
    context,
    payer,
    payer.publicKey,
    oneToken().muln(1_000),
  );
  const { mint: debtMint, ata: payerDebt } = await createMintAndFund(
    context,
    payer,
    payer.publicKey,
    oneToken().muln(1_000_000),
  );

  const liquidatorCollateral = getAssociatedTokenAddressSync(collateralMint, liquidator.publicKey);
  const liquidatorDebt = getAssociatedTokenAddressSync(debtMint, liquidator.publicKey);
  await processTransaction(
    context,
    new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        liquidatorCollateral,
        liquidator.publicKey,
        collateralMint,
      ),
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        liquidatorDebt,
        liquidator.publicKey,
        debtMint,
      ),
      createTransferInstruction(
        payerDebt,
        liquidatorDebt,
        payer.publicKey,
        BigInt(oneToken().muln(100_000).toString()),
      ),
    ),
    [payer],
  );

  const collateralFeed = randomBytes(32);
  const debtFeed = randomBytes(32);
  const collateralPrice = Keypair.generate().publicKey;
  const debtPrice = Keypair.generate().publicKey;

  const setPrices = async (
    collateral: [number, number],
    debt: [number, number],
    age = 0,
  ) => {
    const publishTime = (await getTime(context)) - BigInt(age);
    setPythPrice(context, collateralPrice, collateralFeed, {
      price: collateral[0],
      conf: collateral[1],
      publishTime,
    });
    setPythPrice(context, debtPrice, debtFeed, {
      price: debt[0],
      conf: debt[1],
      publishTime,
    });
  };

  const initIx = await program.methods
    .initialize({
      collateralFeed: [...collateralFeed],
      debtFeed: [...debtFeed],
      maxPriceAge: new BN(MAX_PRICE_AGE),
      borrowLtvBps: BORROW_LTV_BPS,
      liquidationLtvBps: LIQUIDATION_LTV_BPS,
    })
    .accountsPartial({
      admin: payer.publicKey,
      collateralMint,
      debtMint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  await sendIxs(
    context,
    [payer],
    initIx,
    createTransferInstruction(
      payerDebt,
      debtVault,
      payer.publicKey,
      BigInt(oneToken().muln(500_000).toString()),
    ),
  );

  const position = (owner: PublicKey) =>
    findPDA(["position", owner], program)[0];

  return {
    context,
    program,
    payer,
    liquidator,
    market,
    collateralMint,
    debtMint,
    collateralVault,
    debtVault,
    payerCollateral,
    payerDebt,
    liquidatorCollateral,
    liquidatorDebt,
    collateralFeed,
    debtFeed,
    collateralPrice,
    debtPrice,
    position,
    setPrices,
  };
};
