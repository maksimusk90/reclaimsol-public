// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { readPendingTransactions, savePendingTransactions } from "./pending";
import {
  groupPendingTransactions,
  resolvePendingTransactionGroup,
} from "./pending-recovery";

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

const group = [
  { network: "devnet", walletAddress: "wallet-A", accountAddress: "account-A", signature: "sig-A", createdAt: 1000 },
  { network: "devnet", walletAddress: "wallet-A", accountAddress: "account-B", signature: "sig-A", createdAt: 1000 },
];

const confirmed = async (signature: string) => ({
  status: "confirmed" as const,
  signature,
  confirmationStatus: "confirmed" as const,
});

describe("pending transaction batch recovery", () => {
  it("groups only records sharing network, wallet and signature", () => {
    expect(groupPendingTransactions([
      ...group,
      { ...group[0], accountAddress: "account-C", signature: "sig-B" },
      { ...group[0], walletAddress: "wallet-B" },
    ])).toHaveLength(3);
  });

  it("clears all records only after every account is confirmed closed", async () => {
    const storage = createStorage();
    savePendingTransactions(storage, group);
    const inspect = vi.fn(confirmed);
    const getAccountInfo = vi.fn(async () => null);

    const result = await resolvePendingTransactionGroup(
      storage, group, inspect, getAccountInfo, async () => undefined,
    );

    expect(result).toBe("resolved");
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(getAccountInfo).toHaveBeenCalledTimes(2);
    expect(readPendingTransactions(storage)).toEqual([]);
  });

  it("preserves the entire group if an account lookup fails after RPC response loss", async () => {
    const storage = createStorage();
    savePendingTransactions(storage, group);
    const getAccountInfo = vi.fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("RPC timeout"));

    const result = await resolvePendingTransactionGroup(
      storage, group, confirmed, getAccountInfo, async () => undefined,
    );

    expect(result).toBe("incomplete");
    expect(readPendingTransactions(storage)).toEqual(group);
  });

  it("preserves the entire group if any account still exists", async () => {
    const storage = createStorage();
    savePendingTransactions(storage, group);
    const getAccountInfo = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ owner: "token-program" });

    const result = await resolvePendingTransactionGroup(
      storage, group, confirmed, getAccountInfo, async () => undefined,
    );

    expect(result).toBe("incomplete");
    expect(readPendingTransactions(storage)).toEqual(group);
  });

  it("preserves confirmed records when financial reconciliation fails", async () => {
    const storage = createStorage();
    savePendingTransactions(storage, group);

    const result = await resolvePendingTransactionGroup(
      storage,
      group,
      confirmed,
      async () => null,
      async () => { throw new Error("transaction metadata unavailable"); },
    );

    expect(result).toBe("incomplete");
    expect(readPendingTransactions(storage)).toEqual(group);
  });

  it("does not clear a confirmed group without a reconciliation callback", async () => {
    const storage = createStorage();
    savePendingTransactions(storage, group);

    const result = await resolvePendingTransactionGroup(
      storage,
      group,
      confirmed,
      async () => null,
    );

    expect(result).toBe("incomplete");
    expect(readPendingTransactions(storage)).toEqual(group);
  });

  it("keeps the group when the transaction status is unknown", async () => {
    const storage = createStorage();
    savePendingTransactions(storage, group);

    const result = await resolvePendingTransactionGroup(
      storage,
      group,
      async (signature) => ({
        status: "unknown",
        signature,
        reason: "RPC history unavailable",
      }),
      async () => null,
    );

    expect(result).toBe("unknown");
    expect(readPendingTransactions(storage)).toEqual(group);
  });

  it("releases an unknown transaction only after expiry and account existence are verified", async () => {
    const storage = createStorage();
    const expiringGroup = group.map((item) => ({
      ...item,
      blockhash: "recent-blockhash",
      lastValidBlockHeight: 500,
    }));
    savePendingTransactions(storage, expiringGroup);
    const recoverExpired = vi.fn(async () => true);

    const result = await resolvePendingTransactionGroup(
      storage,
      expiringGroup,
      async (signature) => ({
        status: "unknown",
        signature,
        reason: "Transaction signature was not found in the RPC history.",
      }),
      async () => ({ owner: "token-program" }),
      undefined,
      recoverExpired,
    );

    expect(result).toBe("expired");
    expect(recoverExpired).toHaveBeenCalledWith(expiringGroup);
    expect(readPendingTransactions(storage)).toEqual([]);
  });

  it("does not release an unknown transaction without verified expiry", async () => {
    const storage = createStorage();
    savePendingTransactions(storage, group);
    const recoverExpired = vi.fn(async () => false);

    const result = await resolvePendingTransactionGroup(
      storage,
      group,
      async (signature) => ({
        status: "unknown",
        signature,
        reason: "Transaction signature was not found in the RPC history.",
      }),
      async () => ({ owner: "token-program" }),
      undefined,
      recoverExpired,
    );

    expect(result).toBe("incomplete");
    expect(recoverExpired).toHaveBeenCalledOnce();
    expect(readPendingTransactions(storage)).toEqual(group);
  });

  it("never attempts expiry recovery for RPC errors", async () => {
    const storage = createStorage();
    savePendingTransactions(storage, group);
    const recoverExpired = vi.fn(async () => true);

    const result = await resolvePendingTransactionGroup(
      storage,
      group,
      async (signature) => ({ status: "unknown", signature, reason: "RPC timeout" }),
      async () => ({ owner: "token-program" }),
      undefined,
      recoverExpired,
    );

    expect(result).toBe("unknown");
    expect(recoverExpired).not.toHaveBeenCalled();
    expect(readPendingTransactions(storage)).toEqual(group);
  });

  it("clears the whole group when the atomic transaction definitively failed", async () => {
    const storage = createStorage();
    savePendingTransactions(storage, group);

    const result = await resolvePendingTransactionGroup(
      storage,
      group,
      async (signature) => ({
        status: "failed",
        signature,
        error: "Instruction error",
      }),
      async () => { throw new Error("Must not inspect accounts after failure"); },
    );

    expect(result).toBe("failed");
    expect(readPendingTransactions(storage)).toEqual([]);
  });

  it("rejects mixed transaction groups without changing storage", async () => {
    const storage = createStorage();
    savePendingTransactions(storage, group);

    await expect(resolvePendingTransactionGroup(
      storage,
      [group[0], { ...group[1], signature: "other-signature" }],
      confirmed,
      async () => null,
    )).rejects.toThrow("mixed signatures");

    expect(readPendingTransactions(storage)).toEqual(group);
  });
});