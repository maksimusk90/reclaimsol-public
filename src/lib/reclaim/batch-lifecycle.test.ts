// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { executeBatchLifecycle } from "./batch-lifecycle";

describe("executeBatchLifecycle", () => {
  it("prepares and executes batches sequentially", async () => {
    const events: string[] = [];

    const prepareBatch = vi.fn(async (batch: string, index: number) => {
      events.push(`prepare:${index}:${batch}`);

      // Represents a newly prepared transaction with its own blockhash.
      return {
        batch,
        blockhash: `fresh-blockhash-${index}`,
      };
    });

    const executeBatch = vi.fn(
      async (
        prepared: { batch: string; blockhash: string },
        _batch: string,
        index: number,
      ) => {
        events.push(`execute:${index}:${prepared.blockhash}`);
        return {
          batch: prepared.batch,
          signature: `signature-${index}`,
        };
      },
    );

    const result = await executeBatchLifecycle({
      batches: ["batch-A", "batch-B"],
      prepareBatch,
      executeBatch,
    });

    expect(result.status).toBe("completed");

    if (result.status !== "completed") {
      throw new Error("Expected completed lifecycle.");
    }

    expect(result.confirmed).toEqual([
      { batch: "batch-A", signature: "signature-0" },
      { batch: "batch-B", signature: "signature-1" },
    ]);

    expect(events).toEqual([
      "prepare:0:batch-A",
      "execute:0:fresh-blockhash-0",
      "prepare:1:batch-B",
      "execute:1:fresh-blockhash-1",
    ]);

    expect(prepareBatch).toHaveBeenCalledTimes(2);
    expect(executeBatch).toHaveBeenCalledTimes(2);
  });

  it("continues sequentially beyond three batches when every batch is confirmed", async () => {
    const batches = Array.from({ length: 6 }, (_, index) => `batch-${index + 1}`);
    const prepared: number[] = [];
    const executed: number[] = [];

    const result = await executeBatchLifecycle({
      batches,
      prepareBatch: async (_batch, index) => { prepared.push(index); return { index }; },
      executeBatch: async (item) => { executed.push(item.index); return { index: item.index }; },
    });

    expect(result.status).toBe("completed");
    expect(prepared).toEqual([0, 1, 2, 3, 4, 5]);
    expect(executed).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("preserves confirmed batches and stops after the next batch fails", async () => {
    const prepareBatch = vi.fn(async (batch: string) => ({
      batch,
    }));

    const executeBatch = vi.fn(
      async (prepared: { batch: string }) => {
        if (prepared.batch === "batch-B") {
          throw new Error("RPC confirmation failed");
        }

        return {
          batch: prepared.batch,
          signature: "confirmed-signature-A",
        };
      },
    );

    const result = await executeBatchLifecycle({
      batches: ["batch-A", "batch-B", "batch-C"],
      prepareBatch,
      executeBatch,
    });

    expect(result.status).toBe("failed");

    if (result.status !== "failed") {
      throw new Error("Expected failed lifecycle.");
    }

    expect(result.failedBatchIndex).toBe(1);
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe(
      "RPC confirmation failed",
    );

    expect(result.confirmed).toEqual([
      {
        batch: "batch-A",
        signature: "confirmed-signature-A",
      },
    ]);

    // The third batch must not be prepared or executed.
    expect(prepareBatch).toHaveBeenCalledTimes(2);
    expect(executeBatch).toHaveBeenCalledTimes(2);
  });
});