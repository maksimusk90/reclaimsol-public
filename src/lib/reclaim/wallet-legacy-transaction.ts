import {
  Transaction,
  type Message,
  type VersionedTransaction,
} from "@solana/web3.js";

/**
 * Converts an internally prepared legacy message into the native legacy
 * Transaction object expected by Phantom's legacy signing path.
 * No instruction, account meta, fee payer, or blockhash is changed.
 */
export function toWalletLegacyTransaction(
  prepared: VersionedTransaction,
): Transaction {
  if (prepared.message.version !== "legacy") {
    throw new Error("Only legacy messages can be passed to the legacy wallet signing path.");
  }

  const transaction = Transaction.populate(prepared.message as Message);
  const before = prepared.message.serialize();
  const after = transaction.serializeMessage();

  if (before.length !== after.length || !before.every((byte, index) => byte === after[index])) {
    throw new Error("Legacy transaction conversion changed the message. It was not sent.");
  }

  return transaction;
}
