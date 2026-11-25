// @vitest-environment node

import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import {
  describeWalletTransactionResult,
  normalizeWalletSignedTransaction,
} from "./wallet-signed-result";

function makeTransaction() {
  const payer = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const transaction = new Transaction({
    feePayer: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  });
  transaction.add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports: 1234 }));
  return transaction;
}

describe("wallet signed transaction result normalization", () => {
  it("keeps same-realm Transaction instances", () => {
    const transaction = makeTransaction();
    expect(normalizeWalletSignedTransaction(transaction)).toBe(transaction);
  });

  it("normalizes a cross-realm-like transaction wrapper from its serialized bytes", () => {
    const transaction = makeTransaction();
    const foreignRealmLike = {
      serialize: (options: { requireAllSignatures: boolean; verifySignatures: boolean }) => transaction.serialize(options),
      serializeMessage: () => transaction.serializeMessage(),
      compileMessage: () => transaction.compileMessage(),
      signatures: transaction.signatures,
      message: transaction.compileMessage(),
    };

    const normalized = normalizeWalletSignedTransaction(foreignRealmLike);
    expect(normalized).toBeInstanceOf(Transaction);
    expect(normalized.serializeMessage()).toEqual(transaction.serializeMessage());
    expect(normalized.instructions).toHaveLength(1);
  });

  it("reports structural diagnostics without exposing transaction bytes", () => {
    const details = describeWalletTransactionResult({
      serialize: "not-a-function",
      signatures: [],
      message: { version: "legacy" },
      secretLike: "must-not-be-dumped",
    });
    expect(details).toContain("constructor=Object");
    expect(details).toContain("serialize=string");
    expect(details).toContain("messageVersion=legacy");
    expect(details).not.toContain("must-not-be-dumped");
  });

  it("rejects unsupported objects with structural details", () => {
    expect(() => normalizeWalletSignedTransaction({ foo: "bar" })).toThrow(/constructor=Object/);
  });
});