import {
  removePendingTransactions,
  type PendingTransaction,
} from "./pending";
import type { TransactionOutcome } from "./execution";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function groupPendingTransactions(
  records: readonly PendingTransaction[],
): PendingTransaction[][] {
  const groups = new Map<string, PendingTransaction[]>();

  for (const record of records) {
    const key = JSON.stringify([
      record.network,
      record.walletAddress,
      record.signature,
    ]);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }

  return [...groups.values()];
}

/**
 * Resolves all local records associated with one signed transaction together.
 * A confirmed signature is cleared only after financial reconciliation and
 * every affected account is verified absent. An unknown signature is released
 * only when its saved blockhash is expired and every affected account still
 * exists. Any RPC uncertainty preserves the full group.
 */
export async function resolvePendingTransactionGroup(
  storage: StorageLike,
  group: readonly PendingTransaction[],
  inspect: (signature: string) => Promise<TransactionOutcome>,
  getAccountInfo: (accountAddress: string) => Promise<unknown | null>,
  reconcile?: (group: readonly PendingTransaction[]) => Promise<unknown>,
  recoverExpired?: (group: readonly PendingTransaction[]) => Promise<boolean>,
): Promise<"unknown" | "failed" | "resolved" | "expired" | "incomplete"> {
  if (group.length === 0) {
    throw new Error("Cannot resolve an empty pending transaction group.");
  }

  const first = group[0];
  if (group.some((item) =>
    item.network !== first.network ||
    item.walletAddress !== first.walletAddress ||
    item.signature !== first.signature
  )) {
    throw new Error("Pending transaction group contains mixed signatures or wallets.");
  }

  const outcome = await inspect(first.signature);

  if (outcome.status === "unknown") {
    // A missing signature is not enough by itself: the signed blockhash must
    // be past its last valid block height and every affected account must
    // still exist. This distinguishes a transaction that never landed from
    // one that may have closed one or more accounts.
    const signatureNotFound = outcome.reason.includes("not found in the RPC history");
    if (!signatureNotFound || !recoverExpired) return "unknown";
    try {
      if (await recoverExpired(group)) {
        removePendingTransactions(storage, group);
        return "expired";
      }
    } catch {
      return "incomplete";
    }
    return "incomplete";
  }

  if (outcome.status === "failed") {
    removePendingTransactions(storage, group);
    return "failed";
  }

  if (!reconcile) return "incomplete";

  try {
    await reconcile(group);
    for (const item of group) {
      const accountInfo = await getAccountInfo(item.accountAddress);
      if (accountInfo !== null) return "incomplete";
    }
  } catch {
    return "incomplete";
  }

  removePendingTransactions(storage, group);
  return "resolved";
}