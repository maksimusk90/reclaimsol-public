// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { reconcileConfirmedTransaction } from "./reconciliation";

const wallet = Keypair.generate().publicKey;
const treasury = Keypair.generate().publicKey;
const firstAccount = Keypair.generate().publicKey;
const secondAccount = Keypair.generate().publicKey;

function createConfirmedResponse(overrides: Record<string, unknown> = {}) {
  const keys = [wallet, treasury, firstAccount, secondAccount];
  return {
    transaction: {
      message: { staticAccountKeys: keys },
      signatures: [],
    },
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [10_000_000, 1_000_000, 2_000_000, 3_000_000],
      postBalances: [14_245_000, 1_750_000, 0, 0],
      loadedAddresses: { writable: [], readonly: [] },
      ...overrides,
    },
    slot: 100,
    blockTime: 1,
    version: 0,
  };
}

const expected = {
  walletAddress: wallet.toBase58(),
  treasuryAddress: treasury.toBase58(),
  grossRentLamports: BigInt(5_000_000),
  serviceFeeLamports: BigInt(750_000),
  accounts: [
    { address: firstAccount.toBase58(), rentLamports: BigInt(2_000_000) },
    { address: secondAccount.toBase58(), rentLamports: BigInt(3_000_000) },
  ],
};

describe("confirmed transaction reconciliation", () => {
  it("reconciles actual rent, treasury transfer, network fee and wallet net", async () => {
    const connection = {
      getTransaction: vi.fn().mockResolvedValue(createConfirmedResponse()),
    };

    await expect(reconcileConfirmedTransaction(connection as never, "sig", expected)).resolves.toEqual({
      actualNetworkFeeLamports: BigInt(5_000),
      actualGrossRentLamports: BigInt(5_000_000),
      actualServiceFeeLamports: BigInt(750_000),
      actualNetRecoveredLamports: BigInt(4_245_000),
    });
  });

  it("keeps the batch unresolved when RPC metadata is unavailable", async () => {
    const connection = { getTransaction: vi.fn().mockResolvedValue(null) };
    await expect(reconcileConfirmedTransaction(connection as never, "sig", expected)).rejects.toThrow(/metadata is not available/i);
  });

  it("rejects an unexpected treasury transfer", async () => {
    const response = createConfirmedResponse({
      postBalances: [14_245_000, 1_749_999, 0, 0],
    });
    const connection = { getTransaction: vi.fn().mockResolvedValue(response) };
    await expect(reconcileConfirmedTransaction(connection as never, "sig", expected)).rejects.toThrow(/treasury balance change/i);
  });

  it("rejects an account that was not closed to zero", async () => {
    const response = createConfirmedResponse({
      postBalances: [14_245_000, 1_750_000, 1, 0],
    });
    const connection = { getTransaction: vi.fn().mockResolvedValue(response) };
    await expect(reconcileConfirmedTransaction(connection as never, "sig", expected)).rejects.toThrow(/lamport movement/i);
  });

  it("rejects a wallet delta that does not reconcile with actual fees", async () => {
    const response = createConfirmedResponse({
      postBalances: [14_244_999, 1_750_000, 0, 0],
    });
    const connection = { getTransaction: vi.fn().mockResolvedValue(response) };
    await expect(reconcileConfirmedTransaction(connection as never, "sig", expected)).rejects.toThrow(/fee-payer balance change/i);
  });
});
