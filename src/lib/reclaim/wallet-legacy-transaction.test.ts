// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  Keypair,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { toWalletLegacyTransaction } from "./wallet-legacy-transaction";

const payer = Keypair.generate().publicKey;
const recipient = Keypair.generate().publicKey;
const blockhash = Keypair.generate().publicKey.toBase58();

function makePrepared(version: "legacy" | "v0"): VersionedTransaction {
  const builder = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports: 1234 })],
  });
  const message = version === "legacy" ? builder.compileToLegacyMessage() : builder.compileToV0Message();
  return new VersionedTransaction(message);
}

describe("native legacy wallet transaction conversion", () => {
  it("hands the wallet a real Transaction with byte-identical message", () => {
    const prepared = makePrepared("legacy");
    const walletTransaction = toWalletLegacyTransaction(prepared);

    expect(walletTransaction).toBeInstanceOf(Transaction);
    expect(walletTransaction.feePayer?.equals(payer)).toBe(true);
    expect(walletTransaction.recentBlockhash).toBe(blockhash);
    expect(walletTransaction.instructions).toHaveLength(1);
    expect(walletTransaction.serializeMessage()).toEqual(prepared.message.serialize());
  });

  it("rejects v0 messages instead of silently converting them", () => {
    expect(() => toWalletLegacyTransaction(makePrepared("v0"))).toThrow(/Only legacy messages/);
  });
});
