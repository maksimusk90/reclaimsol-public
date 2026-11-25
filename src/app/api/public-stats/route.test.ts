// @vitest-environment node

import { describe, expect, it } from "vitest";
import { reconcilePublicRecovery } from "../../../lib/reclaim/public-stats";

const wallet = "7DNKX6hHn6nYbysgSTCwi3HgM9XEm5fn9aWyBRYjNsU8";
const account = "2FuW5XQzVwb2xSmz1Ly2J1cqDFu4mwmTpiX38J9QamFi";
const treasury = "4fnyv4J1UqBNQRAYjtAFYFuTyMd63z48xhp1iDZ5TaCM";

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    transaction: {
      message: {
        accountKeys: [wallet, account, treasury, "11111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
        instructions: [
          {
            program: "spl-token",
            parsed: { type: "closeAccount", info: { account, destination: wallet, owner: wallet } },
          },
          {
            program: "system",
            parsed: { type: "transfer", info: { source: wallet, destination: treasury, lamports: 223266 } },
          },
        ],
      },
    },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [8380175, 1488440, 1000000, 1, 1],
      postBalances: [9640349, 0, 1223266, 1, 1],
      loadedAddresses: null,
    },
    ...overrides,
  };
}

describe("reconcilePublicRecovery", () => {
  it("counts a finalized-style recovery only when rent, fee transfer and wallet delta reconcile", () => {
    expect(reconcilePublicRecovery(transaction() as never)).toEqual({
      grossLamports: BigInt(1_488_440),
      closedAccounts: 1,
    });
  });

  it("rejects ordinary transfers to the treasury without a token-account closure", () => {
    const tx = transaction() as { transaction: { message: { instructions: Array<Record<string, unknown>> } } };
    tx.transaction.message.instructions = tx.transaction.message.instructions.filter((instruction) => {
      const parsed = instruction.parsed as { type?: string };
      return parsed.type !== "closeAccount";
    });
    expect(reconcilePublicRecovery(tx as never)).toBeNull();
  });

  it("rejects a treasury transfer that does not match the 15% fee", () => {
    const tx = transaction() as { transaction: { message: { instructions: Array<Record<string, unknown>> } } };
    const transfer = tx.transaction.message.instructions[1].parsed as { info: { lamports: number } };
    transfer.info.lamports = 200_000;
    expect(reconcilePublicRecovery(tx as never)).toBeNull();
  });

  it("rejects a transaction with an error", () => {
    const tx = transaction() as { meta: { err: unknown } };
    tx.meta.err = { InstructionError: [0, "Custom"] };
    expect(reconcilePublicRecovery(tx as never)).toBeNull();
  });

  it("rejects a wallet balance delta that does not reconcile", () => {
    const tx = transaction() as { meta: { postBalances: number[] } };
    tx.meta.postBalances[0] += 1;
    expect(reconcilePublicRecovery(tx as never)).toBeNull();
  });
});
