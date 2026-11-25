export type BatchLifecycleResult<TConfirmation> =
  | {
      status: "completed";
      confirmed: TConfirmation[];
    }
  | {
      status: "failed";
      confirmed: TConfirmation[];
      failedBatchIndex: number;
      error: unknown;
    };

export type BatchLifecycleConfig<TBatch, TPrepared, TConfirmation> = {
  batches: readonly TBatch[];

  /**
   * Called immediately before each batch execution.
   * The implementation must revalidate accounts and fetch a fresh blockhash.
   */
  prepareBatch: (
    batch: TBatch,
    index: number,
  ) => Promise<TPrepared>;

  /**
   * Must resolve only after the batch has been confirmed and verified.
   */
  executeBatch: (
    prepared: TPrepared,
    batch: TBatch,
    index: number,
  ) => Promise<TConfirmation>;
};

/**
 * Executes batches strictly one at a time.
 *
 * A failed batch stops the lifecycle. Previously confirmed batches
 * are returned and are never automatically retried.
 */
export async function executeBatchLifecycle<
  TBatch,
  TPrepared,
  TConfirmation,
>(
  config: BatchLifecycleConfig<TBatch, TPrepared, TConfirmation>,
): Promise<BatchLifecycleResult<TConfirmation>> {
  const confirmed: TConfirmation[] = [];

  for (let index = 0; index < config.batches.length; index += 1) {
    const batch = config.batches[index];

    try {
      const prepared = await config.prepareBatch(batch, index);
      const confirmation = await config.executeBatch(
        prepared,
        batch,
        index,
      );

      confirmed.push(confirmation);
    } catch (error) {
      return {
        status: "failed",
        confirmed,
        failedBatchIndex: index,
        error,
      };
    }
  }

  return {
    status: "completed",
    confirmed,
  };
}