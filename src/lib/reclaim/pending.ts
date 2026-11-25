export type PendingTransaction = {
  network: string;
  walletAddress: string;
  accountAddress: string;
  signature: string;
  createdAt: number;
  treasuryAddress?: string;
  grossRentLamports?: string;
  serviceFeeLamports?: string;
  serviceFeeBps?: number;
  accountRentLamports?: string;
  blockhash?: string;
  lastValidBlockHeight?: number;
};

export function createPendingTransaction(
  transaction: Omit<PendingTransaction, "createdAt">,
): PendingTransaction {
  return {
    ...transaction,
    createdAt: Date.now(),
  };
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const STORAGE_KEY = "reclaimsol:pending-transactions:v1";
const MAX_RECORDS = 100;

function isPendingTransaction(value: unknown): value is PendingTransaction {
  if (!value || typeof value !== "object") return false;

  const item = value as Record<string, unknown>;

  return (
    typeof item.network === "string" &&
    item.network.length > 0 &&
    typeof item.walletAddress === "string" &&
    item.walletAddress.length > 0 &&
    typeof item.accountAddress === "string" &&
    item.accountAddress.length > 0 &&
    typeof item.signature === "string" &&
    item.signature.length > 0 &&
    typeof item.createdAt === "number" &&
    Number.isFinite(item.createdAt) &&
    item.createdAt > 0 &&
    (() => {
      const metadata = [
        item.treasuryAddress,
        item.grossRentLamports,
        item.serviceFeeLamports,
        item.serviceFeeBps,
        item.accountRentLamports,
        item.blockhash,
        item.lastValidBlockHeight,
      ];
      const financialMetadata = metadata.slice(0, 5);
      const blockhashMetadata = metadata.slice(5);
      if (financialMetadata.every((value) => value === undefined) && blockhashMetadata.every((value) => value === undefined)) return true;
      const financialValid = financialMetadata.every((value) => value === undefined) || (
        financialMetadata.every((value) => value !== undefined) &&
        typeof item.treasuryAddress === "string" &&
        item.treasuryAddress.length > 0 &&
        typeof item.grossRentLamports === "string" &&
        /^\d+$/.test(item.grossRentLamports) &&
        typeof item.serviceFeeLamports === "string" &&
        /^\d+$/.test(item.serviceFeeLamports) &&
        typeof item.accountRentLamports === "string" &&
        /^\d+$/.test(item.accountRentLamports) &&
        typeof item.serviceFeeBps === "number" &&
        Number.isSafeInteger(item.serviceFeeBps) &&
        item.serviceFeeBps > 0 &&
        item.serviceFeeBps < 10_000
      );
      const blockhashValid = blockhashMetadata.every((value) => value === undefined) || (
        typeof item.blockhash === "string" && item.blockhash.length > 0 &&
        typeof item.lastValidBlockHeight === "number" && Number.isSafeInteger(item.lastValidBlockHeight) && item.lastValidBlockHeight > 0
      );
      return financialValid && blockhashValid;
    })()
  );
}

function recordKey(item: Pick<PendingTransaction, "network" | "walletAddress" | "accountAddress">): string {
  return JSON.stringify([item.network, item.walletAddress, item.accountAddress]);
}

export function readPendingTransactions(
  storage: StorageLike,
): PendingTransaction[] {
  const raw = storage.getItem(STORAGE_KEY);

  if (raw === null) return [];

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "Pending transaction storage is corrupted. Automatic recovery is blocked.",
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      "Pending transaction storage has an invalid format. Automatic recovery is blocked.",
    );
  }

  if (parsed.length > MAX_RECORDS) {
    throw new Error(
      "Pending transaction storage exceeds its safety limit. Automatic recovery is blocked.",
    );
  }

  if (!parsed.every(isPendingTransaction)) {
    throw new Error(
      "Pending transaction storage contains invalid records. Automatic recovery is blocked.",
    );
  }

  return parsed;
}

/**
 * Persists every account associated with one signed transaction in a single
 * localStorage write. If validation or setItem fails, no partial batch is saved.
 */
export function savePendingTransactions(
  storage: StorageLike,
  transactions: readonly PendingTransaction[],
): void {
  if (transactions.length === 0) {
    throw new Error("Cannot save an empty pending transaction batch.");
  }

  if (!transactions.every(isPendingTransaction)) {
    throw new Error("Cannot save an invalid pending transaction batch.");
  }

  const incomingKeys = transactions.map(recordKey);
  if (new Set(incomingKeys).size !== incomingKeys.length) {
    throw new Error("Pending transaction batch contains duplicate accounts.");
  }

  const current = readPendingTransactions(storage);
  const currentByKey = new Map(current.map((item) => [recordKey(item), item]));

  for (const transaction of transactions) {
    const existing = currentByKey.get(recordKey(transaction));
    if (existing && existing.signature !== transaction.signature) {
      throw new Error(
        "Account already has an unresolved pending transaction. Resolve it before saving another signature.",
      );
    }
  }

  const replacedKeys = new Set(incomingKeys);
  const next = current.filter((item) => !replacedKeys.has(recordKey(item)));
  next.push(...transactions);

  if (next.length > MAX_RECORDS) {
    throw new Error(
      "Pending transaction storage is full. Resolve existing transactions first.",
    );
  }

  storage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function savePendingTransaction(
  storage: StorageLike,
  transaction: PendingTransaction,
): void {
  savePendingTransactions(storage, [transaction]);
}

/**
 * Removes an entire transaction group with one storage write. Callers must
 * verify the signature outcome and every affected account before invoking it.
 */
export function removePendingTransactions(
  storage: StorageLike,
  transactions: readonly Pick<
    PendingTransaction,
    "network" | "walletAddress" | "accountAddress" | "signature"
  >[],
): void {
  if (transactions.length === 0) {
    throw new Error("Cannot remove an empty pending transaction batch.");
  }

  if (transactions.some((item) => !item.signature)) {
    throw new Error("Cannot remove pending transactions without signatures.");
  }

  const removalKeys = new Set(
    transactions.map((item) =>
      JSON.stringify([
        item.network,
        item.walletAddress,
        item.accountAddress,
        item.signature,
      ]),
    ),
  );

  const current = readPendingTransactions(storage);
  const next = current.filter(
    (item) =>
      !removalKeys.has(
        JSON.stringify([
          item.network,
          item.walletAddress,
          item.accountAddress,
          item.signature,
        ]),
      ),
  );

  storage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function removePendingTransaction(
  storage: StorageLike,
  network: string,
  walletAddress: string,
  accountAddress: string,
  expectedSignature: string,
): void {
  removePendingTransactions(storage, [{
    network,
    walletAddress,
    accountAddress,
    signature: expectedSignature,
  }]);
}