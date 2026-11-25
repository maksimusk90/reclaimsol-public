// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  readPendingTransactions,
  removePendingTransaction,
  removePendingTransactions,
  savePendingTransaction,
  savePendingTransactions,
} from "./pending";

function createStorage() {
  const values = new Map<string, string>();

  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

const first = {
  network: "devnet",
  walletAddress: "wallet-A",
  accountAddress: "account-A",
  signature: "signature-A",
  createdAt: 1000,
};

describe("pending transaction storage", () => {
  it("stores and restores a pending transaction", () => {
    const storage = createStorage();
    savePendingTransaction(storage, first);
    expect(readPendingTransactions(storage)).toEqual([first]);
  });

  it("stores the exact batch economics needed for later reconciliation", () => {
    const storage = createStorage();
    const prepared = {
      ...first,
      treasuryAddress: "treasury-A",
      grossRentLamports: "4078560",
      serviceFeeLamports: "611784",
      serviceFeeBps: 1500,
      accountRentLamports: "2039280",
    };
    savePendingTransaction(storage, prepared);
    expect(readPendingTransactions(storage)).toEqual([prepared]);
  });

  it("persists blockhash expiry metadata for safe unknown-outcome recovery", () => {
    const storage = createStorage();
    const prepared = { ...first, blockhash: "recent-blockhash", lastValidBlockHeight: 500 };
    savePendingTransaction(storage, prepared);
    expect(readPendingTransactions(storage)).toEqual([prepared]);
  });

  it("rejects incomplete blockhash expiry metadata", () => {
    const storage = createStorage();
    expect(() => savePendingTransaction(storage, {
      ...first,
      blockhash: "recent-blockhash",
    } as never)).toThrow("invalid pending transaction");
    expect(readPendingTransactions(storage)).toEqual([]);
  });

  it("rejects partial or malformed reconciliation metadata", () => {
    const storage = createStorage();
    expect(() => savePendingTransaction(storage, {
      ...first,
      treasuryAddress: "treasury-A",
      grossRentLamports: "not-lamports",
    } as never)).toThrow("invalid pending transaction");
    expect(readPendingTransactions(storage)).toEqual([]);
  });

  it("refuses to overwrite an unresolved signature for the same account", () => {
    const storage = createStorage();
    savePendingTransaction(storage, first);

    expect(() => savePendingTransaction(storage, {
      ...first,
      signature: "signature-B",
      createdAt: 2000,
    })).toThrow("already has an unresolved pending transaction");

    expect(readPendingTransactions(storage)).toEqual([first]);
  });

  it("keeps records for different wallets or networks separate", () => {
    const storage = createStorage();
    savePendingTransaction(storage, first);
    savePendingTransaction(storage, { ...first, network: "mainnet-beta" });
    savePendingTransaction(storage, { ...first, walletAddress: "wallet-B" });
    expect(readPendingTransactions(storage)).toHaveLength(3);
  });

  it("removes only the matching pending transaction", () => {
    const storage = createStorage();
    savePendingTransactions(storage, [
      first,
      { ...first, accountAddress: "account-B" },
    ]);
    removePendingTransaction(storage, "devnet", "wallet-A", "account-A", "signature-A");
    expect(readPendingTransactions(storage)).toEqual([
      { ...first, accountAddress: "account-B" },
    ]);
  });

  it("does not remove a newer record with a different signature", () => {
    const storage = createStorage();
    const newer = { ...first, signature: "signature-B", createdAt: 2000 };
    savePendingTransaction(storage, newer);
    removePendingTransaction(storage, "devnet", "wallet-A", "account-A", "signature-A");
    expect(readPendingTransactions(storage)).toEqual([newer]);
  });

  it("removes a record when its signature matches", () => {
    const storage = createStorage();
    savePendingTransaction(storage, first);
    removePendingTransaction(storage, "devnet", "wallet-A", "account-A", "signature-A");
    expect(readPendingTransactions(storage)).toEqual([]);
  });

  it("writes a complete batch in one storage operation", () => {
    const storage = createStorage();
    const setItem = vi.spyOn(storage, "setItem");
    const batch = [
      first,
      { ...first, accountAddress: "account-B" },
      { ...first, accountAddress: "account-C" },
    ];

    savePendingTransactions(storage, batch);

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(readPendingTransactions(storage)).toEqual(batch);
  });

  it("does not write a partial batch when validation fails", () => {
    const storage = createStorage();
    savePendingTransaction(storage, first);
    const setItem = vi.spyOn(storage, "setItem");

    expect(() => savePendingTransactions(storage, [
      { ...first, accountAddress: "account-B" },
      { ...first, accountAddress: "" },
    ])).toThrow("invalid pending transaction batch");

    expect(setItem).not.toHaveBeenCalled();
    expect(readPendingTransactions(storage)).toEqual([first]);
  });

  it("does not write a partial batch when storage rejects the write", () => {
    const storage = createStorage();
    savePendingTransaction(storage, first);
    const before = readPendingTransactions(storage);
    const failingStorage = {
      getItem: storage.getItem,
      setItem: () => { throw new Error("quota exceeded"); },
    };

    expect(() => savePendingTransactions(failingStorage, [
      { ...first, accountAddress: "account-B" },
      { ...first, accountAddress: "account-C" },
    ])).toThrow("quota exceeded");

    expect(readPendingTransactions(storage)).toEqual(before);
  });

  it("rejects duplicate account entries in one transaction batch", () => {
    const storage = createStorage();
    expect(() => savePendingTransactions(storage, [first, first])).toThrow(
      "duplicate accounts",
    );
  });

  it("removes a matching group in one storage operation", () => {
    const storage = createStorage();
    const second = { ...first, accountAddress: "account-B" };
    savePendingTransactions(storage, [first, second]);
    const setItem = vi.spyOn(storage, "setItem");

    removePendingTransactions(storage, [first, second]);

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(readPendingTransactions(storage)).toEqual([]);
  });

  it("fails closed for malformed stored JSON", () => {
    const storage = createStorage();
    storage.setItem("reclaimsol:pending-transactions:v1", "{broken");
    expect(() => readPendingTransactions(storage)).toThrow(
      "Pending transaction storage is corrupted.",
    );
  });

  it("fails closed when any record is malformed", () => {
    const storage = createStorage();
    storage.setItem(
      "reclaimsol:pending-transactions:v1",
      JSON.stringify([first, { walletAddress: "incomplete" }]),
    );
    expect(() => readPendingTransactions(storage)).toThrow(
      "contains invalid records",
    );
  });

  it("fails closed when the record limit is exceeded", () => {
    const storage = createStorage();
    storage.setItem(
      "reclaimsol:pending-transactions:v1",
      JSON.stringify(Array.from({ length: 101 }, (_, index) => ({
        ...first,
        accountAddress: `account-${index}`,
      }))),
    );
    expect(() => readPendingTransactions(storage)).toThrow(
      "exceeds its safety limit",
    );
  });
});