import bs58 from "bs58";
import { Transaction, type Connection, type VersionedTransaction } from "@solana/web3.js";

export type TransactionOutcome =
  | {
      status: "confirmed";
      signature: string;
      confirmationStatus: "confirmed" | "finalized";
    }
  | {
      status: "failed";
      signature: string;
      error: unknown;
    }
  | {
      status: "unknown";
      signature: string;
      reason: string;
    };

/**
 * Extracts the transaction ID from the wallet-signed transaction.
 * Must be called only after signature verification.
 */
export function getSignedTransactionSignature(
  transaction: Transaction | VersionedTransaction,
): string {
  const signature = transaction instanceof Transaction
    ? transaction.signatures[0]?.signature
    : transaction.signatures[0];

  if (
    !signature ||
    signature.length !== 64 ||
    signature.every((byte) => byte === 0)
  ) {
    throw new Error("Transaction does not contain a valid wallet signature.");
  }

  return bs58.encode(signature);
}

/**
 * Waits for confirmation, but treats block-height expiry as a reason to
 * inspect the signature rather than as proof that the transaction failed.
 * This matters when the RPC confirmation waiter expires after the transaction
 * has already landed and finalized.
 */
export async function confirmTransactionWithStatusFallback(
  connection: Pick<Connection, "confirmTransaction" | "getSignatureStatuses">,
  strategy: {
    signature: string;
    blockhash: string;
    lastValidBlockHeight: number;
  },
): Promise<TransactionOutcome> {
  try {
    const confirmation = await connection.confirmTransaction(
      strategy,
      "confirmed",
    );

    if (confirmation.value.err !== null) {
      const observed = await inspectTransactionOutcome(
        connection,
        strategy.signature,
      );
      if (observed.status !== "unknown") return observed;
      return {
        status: "failed",
        signature: strategy.signature,
        error: confirmation.value.err,
      };
    }

    return {
      status: "confirmed",
      signature: strategy.signature,
      confirmationStatus: "confirmed",
    };
  } catch (error) {
    const observed = await inspectTransactionOutcome(
      connection,
      strategy.signature,
    );
    if (observed.status !== "unknown") return observed;

    return {
      status: "unknown",
      signature: strategy.signature,
      reason: error instanceof Error
        ? `Confirmation wait ended and the signature is not yet verifiable: ${error.message}`
        : "Confirmation wait ended and the signature is not yet verifiable.",
    };
  }
}

/**
 * Checks the RPC status of a transaction.
 *
 * A missing status or RPC error is UNKNOWN, never proof of failure.
 * A transaction is considered successful only at confirmed/finalized
 * commitment. A processed transaction is not sufficient.
 */
export async function inspectTransactionOutcome(
  connection: Pick<Connection, "getSignatureStatuses">,
  signature: string,
): Promise<TransactionOutcome> {
  try {
    const response = await connection.getSignatureStatuses(
      [signature],
      { searchTransactionHistory: true },
    );

    const transactionStatus = response.value[0];

    if (!transactionStatus) {
      return {
        status: "unknown",
        signature,
        reason: "Transaction signature was not found in the RPC history.",
      };
    }

    const confirmationStatus = transactionStatus.confirmationStatus;

    if (
      confirmationStatus !== "confirmed" &&
      confirmationStatus !== "finalized"
    ) {
      return {
        status: "unknown",
        signature,
        reason: "Transaction has not reached confirmed commitment.",
      };
    }

    if (transactionStatus.err !== null) {
      return {
        status: "failed",
        signature,
        error: transactionStatus.err,
      };
    }

    return {
      status: "confirmed",
      signature,
      confirmationStatus,
    };
  } catch (error) {
    return {
      status: "unknown",
      signature,
      reason:
        error instanceof Error
          ? `Could not verify transaction status: ${error.message}`
          : "Could not verify transaction status because the RPC request failed.",
    };
  }
}