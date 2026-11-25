// @vitest-environment node

import { describe, expect, it } from "vitest";
import { TOKEN_PROGRAM_ID, createCloseAccountInstruction } from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  type Message,
} from "@solana/web3.js";
import { validatePhantomLighthouseTransaction } from "./phantom-lighthouse";

const LIGHTHOUSE_PROGRAM_ID = new PublicKey("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
const wallet = Keypair.generate().publicKey;
const tokenAccount = Keypair.generate().publicKey;
const secondTokenAccount = Keypair.generate().publicKey;
const treasury = Keypair.generate().publicKey;
const blockhash = Keypair.generate().publicKey.toBase58();

function u64(value: bigint): number[] {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return [...bytes];
}

function walletGuard(minimumLamports = BigInt(4_517_928)): TransactionInstruction {
  // 06 AssertAccountInfoMulti; 04 FailedPlaintextMessage; vec length 3:
  // Lamports >= minimum; KnownOwner(System) ==; DataLength(0) ==.
  const data = [
    6, 4, 3,
    0, ...u64(minimumLamports), 4,
    3, 0, 0,
    1, ...u64(BigInt(0)), 0,
  ];
  return new TransactionInstruction({
    programId: LIGHTHOUSE_PROGRAM_ID,
    keys: [{ pubkey: wallet, isSigner: true, isWritable: true }],
    data: Buffer.from(data),
  });
}

function closedAccountGuard(account = tokenAccount): TransactionInstruction {
  // KnownOwner(System) ==; DataLength(0) ==.
  const data = [6, 4, 2, 3, 0, 0, 1, ...u64(BigInt(0)), 0];
  return new TransactionInstruction({
    programId: LIGHTHOUSE_PROGRAM_ID,
    keys: [{ pubkey: account, isSigner: false, isWritable: true }],
    data: Buffer.from(data),
  });
}

function makeMessage(instructions: TransactionInstruction[]): Message {
  return new TransactionMessage({ payerKey: wallet, recentBlockhash: blockhash, instructions }).compileToLegacyMessage();
}

function baseInstructions() {
  return [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 684 }),
    createCloseAccountInstruction(tokenAccount, wallet, wallet, [], TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: wallet, toPubkey: treasury, lamports: 223_266 }),
  ];
}

function makeReturned(overrides: {
  limit?: number;
  price?: bigint;
  walletInstruction?: TransactionInstruction;
  accountInstruction?: TransactionInstruction;
  extra?: TransactionInstruction[];
} = {}) {
  return makeMessage([
    ComputeBudgetProgram.setComputeUnitLimit({ units: overrides.limit ?? 9_770 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: overrides.price ?? BigInt(0) }),
    ...baseInstructions().slice(2),
    overrides.walletInstruction ?? walletGuard(),
    overrides.accountInstruction ?? closedAccountGuard(),
    ...(overrides.extra ?? []),
  ]);
}

describe("strict Phantom Lighthouse transaction validation", () => {
  it("accepts the exact wallet and closed-account postconditions with a bounded CU uplift", () => {
    const result = validatePhantomLighthouseTransaction(
      makeMessage(baseInstructions()),
      makeReturned(),
      wallet.toBase58(),
      [tokenAccount.toBase58()],
    );
    expect(result).toEqual({ ok: true, walletMinimumLamports: BigInt(4_517_928), computeUnitLimit: 9_770 });
  });


  it("accepts reordered Lighthouse assertions for a multi-account batch by matching target addresses", () => {
    const original = makeMessage([
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000 }),
      createCloseAccountInstruction(tokenAccount, wallet, wallet, [], TOKEN_PROGRAM_ID),
      createCloseAccountInstruction(secondTokenAccount, wallet, wallet, [], TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: wallet, toPubkey: treasury, lamports: 300_000 }),
    ]);
    const returned = makeMessage([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }),
      createCloseAccountInstruction(tokenAccount, wallet, wallet, [], TOKEN_PROGRAM_ID),
      createCloseAccountInstruction(secondTokenAccount, wallet, wallet, [], TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: wallet, toPubkey: treasury, lamports: 300_000 }),
      closedAccountGuard(secondTokenAccount),
      walletGuard(),
      closedAccountGuard(tokenAccount),
    ]);

    const result = validatePhantomLighthouseTransaction(
      original,
      returned,
      wallet.toBase58(),
      [tokenAccount.toBase58(), secondTokenAccount.toBase58()],
    );
    expect(result).toEqual({ ok: true, walletMinimumLamports: BigInt(4_517_928), computeUnitLimit: 20_000 });
  });

  it("rejects duplicate Lighthouse assertions for one closed account", () => {
    const original = makeMessage(baseInstructions());
    const returned = makeMessage([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 9_770 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }),
      ...baseInstructions().slice(2),
      walletGuard(),
      closedAccountGuard(),
      closedAccountGuard(),
    ]);
    const result = validatePhantomLighthouseTransaction(
      original,
      returned,
      wallet.toBase58(),
      [tokenAccount.toBase58()],
    );
    expect(result).toEqual({ ok: false, reason: "Unexpected number of Lighthouse assertions." });
  });

  it("rejects a changed treasury transfer", () => {
    const changedTransfer = SystemProgram.transfer({ fromPubkey: wallet, toPubkey: treasury, lamports: 223_267 });
    const result = validatePhantomLighthouseTransaction(
      makeMessage(baseInstructions()),
      makeMessage([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 9_770 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }),
        ...baseInstructions().slice(2, 3),
        changedTransfer,
        walletGuard(),
        closedAccountGuard(),
      ]),
      wallet.toBase58(),
      [tokenAccount.toBase58()],
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a nonzero priority fee", () => {
    const result = validatePhantomLighthouseTransaction(
      makeMessage(baseInstructions()),
      makeReturned({ price: BigInt(1) }),
      wallet.toBase58(),
      [tokenAccount.toBase58()],
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an unbounded compute-unit limit", () => {
    const result = validatePhantomLighthouseTransaction(
      makeMessage(baseInstructions()),
      makeReturned({ limit: 1_400_001 }),
      wallet.toBase58(),
      [tokenAccount.toBase58()],
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a Lighthouse assertion targeting another token account", () => {
    const result = validatePhantomLighthouseTransaction(
      makeMessage(baseInstructions()),
      makeReturned({ accountInstruction: closedAccountGuard(Keypair.generate().publicKey) }),
      wallet.toBase58(),
      [tokenAccount.toBase58()],
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed or non-postcondition Lighthouse instruction", () => {
    const malformed = new TransactionInstruction({
      programId: LIGHTHOUSE_PROGRAM_ID,
      keys: [{ pubkey: wallet, isSigner: true, isWritable: true }],
      data: Buffer.from([0, 1, 2]),
    });
    const result = validatePhantomLighthouseTransaction(
      makeMessage(baseInstructions()),
      makeReturned({ walletInstruction: malformed }),
      wallet.toBase58(),
      [tokenAccount.toBase58()],
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an extra signer or unknown instruction", () => {
    const extra = SystemProgram.transfer({ fromPubkey: wallet, toPubkey: Keypair.generate().publicKey, lamports: 1 });
    const result = validatePhantomLighthouseTransaction(
      makeMessage(baseInstructions()),
      makeReturned({ extra: [extra] }),
      wallet.toBase58(),
      [tokenAccount.toBase58()],
    );
    expect(result.ok).toBe(false);
  });
});
