// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  TransactionMessage,
  type TransactionInstruction,
  type VersionedTransaction,
} from "@solana/web3.js";
import { describeTransactionMessageChanges } from "./message-integrity";

const payer = Keypair.generate().publicKey;
const recipientA = Keypair.generate().publicKey;
const recipientB = Keypair.generate().publicKey;
const blockhashA = Keypair.generate().publicKey.toBase58();
const blockhashB = Keypair.generate().publicKey.toBase58();

function makeTransaction(
  recipient = recipientA,
  lamports = 10,
  blockhash = blockhashA,
  extra: TransactionInstruction[] = [],
): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports }),
      ...extra,
    ],
  }).compileToV0Message();
  return { message } as VersionedTransaction;
}

describe("transaction message integrity diagnostics", () => {
  it("reports no changes for identical messages", () => {
    const transaction = makeTransaction();
    expect(describeTransactionMessageChanges(transaction.message, transaction.message)).toEqual([]);
  });

  it("identifies a changed recent blockhash", () => {
    const original = makeTransaction();
    const changed = makeTransaction(recipientA, 10, blockhashB);
    expect(
      describeTransactionMessageChanges(original.message, changed.message).some((item) =>
        item.includes("recent blockhash changed"),
      ),
    ).toBe(true);
  });

  it("identifies changed account keys without exposing their values", () => {
    const original = makeTransaction(recipientA);
    const changed = makeTransaction(recipientB);
    const summary = describeTransactionMessageChanges(original.message, changed.message).join(" ");
    expect(summary).toContain("account key list changed");
    expect(summary).toContain(recipientA.toBase58());
    expect(summary).toContain(recipientB.toBase58());
  });

  it("identifies changed instruction data", () => {
    const original = makeTransaction(recipientA, 10);
    const changed = makeTransaction(recipientA, 11);
    expect(
      describeTransactionMessageChanges(original.message, changed.message).some((item) =>
        item.includes("instruction 1: instruction data changed"),
      ),
    ).toBe(true);
  });

  it("identifies a wallet-added Compute Budget instruction with exact program and payload details", () => {
    const original = makeTransaction();
    const changed = makeTransaction(recipientA, 10, blockhashA, [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1234 }),
    ]);
    const summary = describeTransactionMessageChanges(original.message, changed.message).join("\n");

    expect(summary).toContain("instruction count changed (1 → 2)");
    expect(summary).toContain("wallet-added instruction 2: Compute Budget Program");
    expect(summary).toContain(ComputeBudgetProgram.programId.toBase58());
    expect(summary).toContain("SetComputeUnitPrice(microLamports=1234)");
    expect(summary).toContain("data=hex:");
    expect(summary).toContain("accounts=[]");
  });

  it("shows exact before/after program and account references when an instruction changes", () => {
    const original = makeTransaction(recipientA);
    const changed = makeTransaction(recipientB);
    const summary = describeTransactionMessageChanges(original.message, changed.message).join("\n");

    expect(summary).toContain("instruction 1: program/account references changed");
    expect(summary).toContain(recipientA.toBase58());
    expect(summary).toContain(recipientB.toBase58());
    expect(summary).toContain("System Program");
  });
});