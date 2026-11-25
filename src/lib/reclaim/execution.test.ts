// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  Keypair,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  confirmTransactionWithStatusFallback,
  getSignedTransactionSignature,
  inspectTransactionOutcome,
} from "./execution";

function createTransaction(): VersionedTransaction {
  const payer = Keypair.generate();

  return new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [],
    }).compileToV0Message(),
  );
}

describe("getSignedTransactionSignature", () => {
  it("extracts a Base58 signature from a signed transaction", () => {
    const transaction = createTransaction();
    transaction.signatures[0] = new Uint8Array(64).fill(7);

    const signature = getSignedTransactionSignature(transaction);

    expect(signature).toHaveLength(87);
    expect(signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it("rejects an unsigned transaction", () => {
    const transaction = createTransaction();

    expect(() => getSignedTransactionSignature(transaction)).toThrow(
      "Transaction does not contain a valid wallet signature.",
    );
  });

  it("rejects an incorrectly sized signature", () => {
    const transaction = createTransaction();
    transaction.signatures[0] = new Uint8Array(32).fill(7);

    expect(() => getSignedTransactionSignature(transaction)).toThrow();
  });
});

describe("inspectTransactionOutcome", () => {
  const signature = "test-signature";

  it("recognizes a confirmed transaction", async () => {
    const connection = {
      getSignatureStatuses: vi.fn().mockResolvedValue({
        value: [
          {
            err: null,
            confirmationStatus: "confirmed",
            confirmations: 1,
            slot: 100,
          },
        ],
      }),
    };

    const result = await inspectTransactionOutcome(
      connection as never,
      signature,
    );

    expect(result).toEqual({
      status: "confirmed",
      signature,
      confirmationStatus: "confirmed",
    });

    expect(connection.getSignatureStatuses).toHaveBeenCalledWith(
      [signature],
      { searchTransactionHistory: true },
    );
  });

  it("recognizes a finalized transaction", async () => {
    const connection = {
      getSignatureStatuses: vi.fn().mockResolvedValue({
        value: [
          {
            err: null,
            confirmationStatus: "finalized",
            confirmations: null,
            slot: 100,
          },
        ],
      }),
    };

    const result = await inspectTransactionOutcome(
      connection as never,
      signature,
    );

    expect(result.status).toBe("confirmed");
  });

  it("recognizes an execution error", async () => {
    const transactionError = { InstructionError: [2, "Custom"] };

    const connection = {
      getSignatureStatuses: vi.fn().mockResolvedValue({
        value: [
          {
            err: transactionError,
            confirmationStatus: "confirmed",
            confirmations: 1,
            slot: 100,
          },
        ],
      }),
    };

    const result = await inspectTransactionOutcome(
      connection as never,
      signature,
    );

    expect(result).toEqual({
      status: "failed",
      signature,
      error: transactionError,
    });
  });

  it("returns unknown for an execution error before confirmed commitment", async () => {
    const connection = {
      getSignatureStatuses: vi.fn().mockResolvedValue({
        value: [
          {
            err: { InstructionError: [2, "Custom"] },
            confirmationStatus: "processed",
            confirmations: 0,
            slot: 100,
          },
        ],
      }),
    };

    const result = await inspectTransactionOutcome(
      connection as never,
      signature,
    );

    expect(result.status).toBe("unknown");
  });

  it("returns unknown when the signature is not found", async () => {
    const connection = {
      getSignatureStatuses: vi.fn().mockResolvedValue({
        value: [null],
      }),
    };

    const result = await inspectTransactionOutcome(
      connection as never,
      signature,
    );

    expect(result.status).toBe("unknown");
  });

  it("returns unknown for a processed transaction", async () => {
    const connection = {
      getSignatureStatuses: vi.fn().mockResolvedValue({
        value: [
          {
            err: null,
            confirmationStatus: "processed",
            confirmations: 0,
            slot: 100,
          },
        ],
      }),
    };

    const result = await inspectTransactionOutcome(
      connection as never,
      signature,
    );

    expect(result.status).toBe("unknown");
  });

  it("returns unknown when RPC throws", async () => {
    const connection = {
      getSignatureStatuses: vi.fn().mockRejectedValue(
        new Error("RPC timeout"),
      ),
    };

    const result = await inspectTransactionOutcome(
      connection as never,
      signature,
    );

    expect(result.status).toBe("unknown");

    if (result.status === "unknown") {
      expect(result.reason).toContain("RPC timeout");
    }
  });
});

describe("confirmTransactionWithStatusFallback", () => {
  const strategy = {
    signature: "test-signature",
    blockhash: "test-blockhash",
    lastValidBlockHeight: 100,
  };

  it("recognizes a finalized transaction when the confirmation waiter expires", async () => {
    const connection = {
      confirmTransaction: vi.fn().mockRejectedValue(new Error("block height exceeded")),
      getSignatureStatuses: vi.fn().mockResolvedValue({
        value: [{
          err: null,
          confirmationStatus: "finalized",
          confirmations: null,
          slot: 200,
        }],
      }),
    };

    await expect(confirmTransactionWithStatusFallback(connection as never, strategy)).resolves.toEqual({
      status: "confirmed",
      signature: strategy.signature,
      confirmationStatus: "finalized",
    });
  });

  it("keeps the result unknown when the waiter expires and the signature is absent", async () => {
    const connection = {
      confirmTransaction: vi.fn().mockRejectedValue(new Error("block height exceeded")),
      getSignatureStatuses: vi.fn().mockResolvedValue({ value: [null] }),
    };

    const result = await confirmTransactionWithStatusFallback(connection as never, strategy);
    expect(result.status).toBe("unknown");
    if (result.status === "unknown") {
      expect(result.reason).toContain("block height exceeded");
    }
  });

  it("preserves a definitive on-chain execution failure", async () => {
    const transactionError = { InstructionError: [1, "Custom"] };
    const connection = {
      confirmTransaction: vi.fn().mockRejectedValue(new Error("confirmation waiter stopped")),
      getSignatureStatuses: vi.fn().mockResolvedValue({
        value: [{
          err: transactionError,
          confirmationStatus: "confirmed",
          confirmations: 1,
          slot: 200,
        }],
      }),
    };

    await expect(confirmTransactionWithStatusFallback(connection as never, strategy)).resolves.toEqual({
      status: "failed",
      signature: strategy.signature,
      error: transactionError,
    });
  });
});