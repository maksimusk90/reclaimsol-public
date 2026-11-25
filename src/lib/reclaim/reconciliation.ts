import type { Connection } from "@solana/web3.js";
export type ReconciliationAccount = {
  address: string;
  rentLamports?: bigint;
};

export type ConfirmedTransactionExpectation = {
  walletAddress: string;
  treasuryAddress: string;
  grossRentLamports?: bigint;
  serviceFeeLamports?: bigint;
  serviceFeeBps?: number;
  accounts: readonly ReconciliationAccount[];
};

export type ConfirmedTransactionReconciliation = {
  actualNetworkFeeLamports: bigint;
  actualGrossRentLamports: bigint;
  actualServiceFeeLamports: bigint;
  actualNetRecoveredLamports: bigint;
};

/**
 * Reconciles the confirmed transaction metadata with the exact batch that
 * was prepared and signed. Missing metadata or any unexpected movement fails
 * closed so the pending record remains available for a later recheck.
 */
export async function reconcileConfirmedTransaction(
  connection: Pick<Connection, "getTransaction">,
  signature: string,
  expected: ConfirmedTransactionExpectation,
): Promise<ConfirmedTransactionReconciliation> {
  if (expected.accounts.length === 0) {
    throw new Error("Cannot reconcile an empty recovery batch.");
  }

  const transaction = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });

  if (!transaction || !transaction.meta) {
    throw new Error("Confirmed transaction metadata is not available yet; keep the batch pending and recheck later.");
  }

  if (transaction.meta.err !== null) {
    throw new Error("Confirmed transaction metadata reports an execution error.");
  }

  const accountKeys = transaction.transaction.message.staticAccountKeys;

  const loadedAddresses = transaction.meta.loadedAddresses;
  if (
    loadedAddresses &&
    (loadedAddresses.writable.length > 0 || loadedAddresses.readonly.length > 0)
  ) {
    throw new Error("Unexpected address lookup table accounts in recovery transaction metadata.");
  }

  const preBalances = transaction.meta.preBalances;
  const postBalances = transaction.meta.postBalances;

  if (
    accountKeys.length === 0 ||
    preBalances.length !== accountKeys.length ||
    postBalances.length !== accountKeys.length ||
    !preBalances.every((value) => Number.isSafeInteger(value) && value >= 0) ||
    !postBalances.every((value) => Number.isSafeInteger(value) && value >= 0) ||
    !Number.isSafeInteger(transaction.meta.fee) ||
    transaction.meta.fee < 0
  ) {
    throw new Error("Confirmed transaction metadata contains invalid balance or fee arrays.");
  }

  const indices = new Map(accountKeys.map((key, index) => [key.toBase58(), index]));
  const walletIndex = indices.get(expected.walletAddress);
  const treasuryIndex = indices.get(expected.treasuryAddress);

  if (walletIndex !== 0 || treasuryIndex === undefined || treasuryIndex === walletIndex) {
    throw new Error("Confirmed transaction metadata has an unexpected fee payer or treasury account.");
  }

  const actualGross = expected.accounts.reduce((sum, account) => {
    const index = indices.get(account.address);
    if (index === undefined) {
      throw new Error("A prepared token account is missing from confirmed transaction metadata.");
    }

    const before = preBalances[index];
    const after = postBalances[index];
    if (
      !Number.isSafeInteger(before) ||
      !Number.isSafeInteger(after) ||
      before <= 0 ||
      after !== 0 ||
      (account.rentLamports !== undefined && BigInt(before) !== account.rentLamports)
    ) {
      throw new Error("A token account's actual lamport movement does not match the prepared close.");
    }

    return sum + BigInt(before);
  }, BigInt(0));

  const serviceFeeLamports =
    expected.serviceFeeLamports ??
    (expected.serviceFeeBps !== undefined
      ? (actualGross * BigInt(expected.serviceFeeBps)) / BigInt(10_000)
      : BigInt(-1));

  if (
    actualGross <= BigInt(0) ||
    (expected.serviceFeeBps !== undefined &&
      (!Number.isSafeInteger(expected.serviceFeeBps) || expected.serviceFeeBps < 1 || expected.serviceFeeBps >= 10_000)) ||
    (expected.grossRentLamports !== undefined && actualGross !== expected.grossRentLamports) ||
    serviceFeeLamports < BigInt(0) ||
    serviceFeeLamports > actualGross
  ) {
    throw new Error("Prepared recovery economics do not match the account set.");
  }

  const treasuryDelta = BigInt(postBalances[treasuryIndex]) - BigInt(preBalances[treasuryIndex]);
  if (treasuryDelta !== serviceFeeLamports) {
    throw new Error("Confirmed treasury balance change does not match the prepared service fee.");
  }

  const actualNetworkFeeLamports = BigInt(transaction.meta.fee);
  const actualNetRecoveredLamports =
    actualGross - serviceFeeLamports - actualNetworkFeeLamports;
  const walletDelta = BigInt(postBalances[walletIndex]) - BigInt(preBalances[walletIndex]);

  if (walletDelta !== actualNetRecoveredLamports) {
    throw new Error("Confirmed fee-payer balance change does not reconcile with rent, service fee, and network fee.");
  }

  return {
    actualNetworkFeeLamports,
    actualGrossRentLamports: actualGross,
    actualServiceFeeLamports: treasuryDelta,
    actualNetRecoveredLamports,
  };
}
