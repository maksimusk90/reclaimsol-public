import {
  createBurnCheckedInstruction,
  createCloseAccountInstruction,
  createHarvestWithheldTokensToMintInstruction,
  getTransferFeeAmount,
  getTransferFeeConfig,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";

import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import { evaluateAccountExtensions, parseExtensionTypesSafe } from "./extensions";

import { ClosePreparationError } from "./transaction";

const PACKET_LIMIT_BYTES = 1232;
export const MAX_ACCOUNTS_PER_TRANSACTION = 8;
const MAX_COMPUTE_UNITS = 1_400_000;
const COMPUTE_UNITS_PER_CLOSE = 100_000;
const COMPUTE_UNITS_PER_HARVEST = 100_000;
const COMPUTE_UNIT_SAFETY_MULTIPLIER = 1.2;
const MAX_ACCOUNT_INSPECTION_CONCURRENCY = 8;

async function mapWithConcurrency<TItem, TResult>(
  items: readonly TItem[],
  concurrency: number,
  mapper: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, concurrency));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

export type BatchAccount = {
  address: string;
  tokenProgram: "SPL Token" | "Token-2022";
  rentLamports: bigint;
  mintAddress: string;
  withheldAmount: bigint;
  tokenAmount: bigint;
  mintDecimals: number;
};

export type PreparedCloseBatch = {
  batchIndex: number;
  accounts: BatchAccount[];
  destinationAddress: string;
  treasuryAddress: string;
  serviceFeeBps: number;
  grossRentLamports: bigint;
  serviceFeeLamports: bigint;
  estimatedNetRecoveredLamports: bigint;
  estimatedNetworkFeeLamports: bigint;
  computeUnitLimit: number;
  simulatedComputeUnits: number;
  serializedSizeBytes: number;
  blockhash: string;
  lastValidBlockHeight: number;
  transaction: VersionedTransaction;
};

export type BatchPreparationConfig = {
  walletAddress: string;
  accountAddresses: string[];
  connection: Connection;
  treasuryAddress: string;
  serviceFeeBps: number;
  /** Accounts explicitly selected after the user acknowledged mint harvesting. */
  harvestAccountAddresses?: string[];
  /** Accounts explicitly selected for irreversible full-balance burning. */
  burnAccountAddresses?: string[];
};

function validateConfig(
  walletAddress: string,
  treasuryAddress: string,
  serviceFeeBps: number,
): { wallet: PublicKey; treasury: PublicKey } {
  const wallet = new PublicKey(walletAddress);
  const treasury = new PublicKey(treasuryAddress);

  if (
    treasury.equals(PublicKey.default) ||
    treasury.equals(wallet) ||
    !Number.isSafeInteger(serviceFeeBps) ||
    serviceFeeBps < 1 ||
    serviceFeeBps >= 10_000
  ) {
    throw new Error("Invalid service fee configuration or treasury address.");
  }

  return { wallet, treasury };
}

async function inspectAccount(
  wallet: PublicKey,
  address: PublicKey,
  connection: Connection,
  burnConsent: boolean,
): Promise<BatchAccount> {
  const info = await connection.getAccountInfo(address, "confirmed");

  if (!info) {
    throw new ClosePreparationError(
      "ACCOUNT_NOT_FOUND",
      `Token account ${address.toBase58()} no longer exists.`,
    );
  }

  let programId: PublicKey;
  let tokenProgram: BatchAccount["tokenProgram"];

  if (info.owner.equals(TOKEN_PROGRAM_ID)) {
    programId = TOKEN_PROGRAM_ID;
    tokenProgram = "SPL Token";
  } else if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    programId = TOKEN_2022_PROGRAM_ID;
    tokenProgram = "Token-2022";
  } else {
    throw new ClosePreparationError(
      "UNSUPPORTED_PROGRAM",
      `Account ${address.toBase58()} is not owned by a supported token program.`,
    );
  }

  const parsed = unpackAccount(address, info, programId);

  if (!parsed.isInitialized) {
    throw new ClosePreparationError(
      "ACCOUNT_NOT_INITIALIZED",
      `Account ${address.toBase58()} is not initialized.`,
    );
  }

  if (parsed.isNative) {
    throw new ClosePreparationError(
      "NATIVE_ACCOUNT",
      `Wrapped SOL account ${address.toBase58()} is not supported.`,
    );
  }

  if (parsed.amount > BigInt(0) && !burnConsent) {
    throw new ClosePreparationError(
      "BURN_CONSENT_REQUIRED",
      `Account ${address.toBase58()} contains tokens. Explicit burn consent is required.`,
    );
  }

  if (parsed.amount > BigInt(0) && !parsed.owner.equals(wallet)) {
    throw new ClosePreparationError(
      "BURN_AUTHORITY_MISMATCH",
      `Wallet is not the token owner for ${address.toBase58()}; delegated or third-party burn authority is not accepted.`,
    );
  }

  if (parsed.isFrozen) {
    throw new ClosePreparationError("FROZEN_ACCOUNT", `Account ${address.toBase58()} is frozen.`);
  }

  const closeAuthority = parsed.closeAuthority ?? parsed.owner;

  if (!closeAuthority.equals(wallet)) {
    throw new ClosePreparationError(
      "AUTHORITY_MISMATCH",
      `Wallet is not the close authority for ${address.toBase58()}.`,
    );
  }

  let withheldAmount = BigInt(0);

  if (programId.equals(TOKEN_2022_PROGRAM_ID)) {
    const extensions = parseExtensionTypesSafe(parsed.tlvData);
    const evaluation = evaluateAccountExtensions(extensions);

    if (!evaluation.allowed) {
      throw new ClosePreparationError(
        "UNSUPPORTED_EXTENSION",
        `Account ${address.toBase58()} has unsupported extension: ${
          evaluation.unsupportedName ?? "unknown"
        }.`,
      );
    }

    const transferFee = getTransferFeeAmount(parsed);
    withheldAmount = transferFee?.withheldAmount ?? BigInt(0);

    if (withheldAmount > BigInt(0)) {
      const mintInfo = await connection.getAccountInfo(parsed.mint, "confirmed");
      if (!mintInfo || !mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        throw new ClosePreparationError(
          "WITHHELD_MINT_INVALID",
          `Mint for account ${address.toBase58()} is not a valid Token-2022 mint.`,
        );
      }
      const mint = unpackMint(parsed.mint, mintInfo, TOKEN_2022_PROGRAM_ID);
      if (!getTransferFeeConfig(mint)) {
        throw new ClosePreparationError(
          "WITHHELD_MINT_CONFIG_MISSING",
          `Mint for account ${address.toBase58()} has no Transfer Fee configuration.`,
        );
      }
    }
  }

  let mintDecimals = 0;
  if (parsed.amount > BigInt(0)) {
    const mintInfo = await connection.getAccountInfo(parsed.mint, "confirmed");
    if (!mintInfo || !mintInfo.owner.equals(programId)) {
      throw new ClosePreparationError(
        "BURN_MINT_INVALID",
        `Mint for account ${address.toBase58()} is missing or owned by another program.`,
      );
    }
    const mint = unpackMint(parsed.mint, mintInfo, programId);
    mintDecimals = mint.decimals;
    if (!Number.isInteger(mintDecimals) || mintDecimals < 0 || mintDecimals > 255) {
      throw new ClosePreparationError(
        "BURN_MINT_DECIMALS_INVALID",
        `Mint decimals for ${address.toBase58()} are invalid.`,
      );
    }
  }

  const rentLamports = BigInt(info.lamports);

  if (rentLamports <= BigInt(0)) {
    throw new Error(`Account ${address.toBase58()} has no recoverable lamports.`);
  }

  return {
    address: address.toBase58(),
    tokenProgram,
    rentLamports,
    mintAddress: parsed.mint.toBase58(),
    withheldAmount,
    tokenAmount: parsed.amount,
    mintDecimals,
  };
}

function buildTransaction(
  wallet: PublicKey,
  treasury: PublicKey,
  accounts: BatchAccount[],
  serviceFeeLamports: bigint,
  blockhash: string,
  computeUnitLimit: number,
): VersionedTransaction {
  if (computeUnitLimit <= 0 || computeUnitLimit > MAX_COMPUTE_UNITS) {
    throw new Error("Batch exceeds the configured compute-unit budget.");
  }

  if (serviceFeeLamports <= BigInt(0)) {
    throw new Error("Batch service fee must be greater than zero.");
  }

  if (serviceFeeLamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Batch service fee exceeds the safe integer range.");
  }

  const harvestSourcesByMint = new Map<string, string[]>();
  for (const account of accounts) {
    if (account.withheldAmount <= BigInt(0)) continue;
    const sources = harvestSourcesByMint.get(account.mintAddress) ?? [];
    sources.push(account.address);
    harvestSourcesByMint.set(account.mintAddress, sources);
  }

  const harvestInstructions = [...harvestSourcesByMint.entries()].map(([mintAddress, sources]) =>
    createHarvestWithheldTokensToMintInstruction(
      new PublicKey(mintAddress),
      sources.map((source) => new PublicKey(source)),
      TOKEN_2022_PROGRAM_ID,
    ),
  );

  const instructions = [
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 0,
    }),
    ComputeBudgetProgram.setComputeUnitLimit({
      units: computeUnitLimit,
    }),
    ...harvestInstructions,
    ...accounts
      .filter((item) => item.tokenAmount > BigInt(0))
      .map((item) =>
        createBurnCheckedInstruction(
          new PublicKey(item.address),
          new PublicKey(item.mintAddress),
          wallet,
          item.tokenAmount,
          item.mintDecimals,
          [],
          item.tokenProgram === "SPL Token" ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
        ),
      ),
    ...accounts.map((item) =>
      createCloseAccountInstruction(
        new PublicKey(item.address),
        wallet,
        wallet,
        [],
        item.tokenProgram === "SPL Token" ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
      ),
    ),
    SystemProgram.transfer({
      fromPubkey: wallet,
      toPubkey: treasury,
      lamports: Number(serviceFeeLamports),
    }),
  ];

  const message = new TransactionMessage({
    payerKey: wallet,
    recentBlockhash: blockhash,
    instructions,
  }).compileToLegacyMessage();

  return new VersionedTransaction(message);
}

export function validatePreparedCloseBatch(
  prepared: PreparedCloseBatch,
  walletAddress: string,
  expectedServiceFeeBps: number,
  expectedTreasuryAddress: string,
): void {
  const { wallet, treasury } = validateConfig(
    walletAddress,
    expectedTreasuryAddress,
    expectedServiceFeeBps,
  );

  if (
    prepared.destinationAddress !== walletAddress ||
    prepared.treasuryAddress !== treasury.toBase58() ||
    prepared.serviceFeeBps !== expectedServiceFeeBps ||
    prepared.accounts.length === 0 ||
    prepared.accounts.length > MAX_ACCOUNTS_PER_TRANSACTION ||
    !Number.isSafeInteger(prepared.computeUnitLimit) ||
    prepared.computeUnitLimit <= 0 ||
    prepared.computeUnitLimit > MAX_COMPUTE_UNITS ||
    !Number.isSafeInteger(prepared.simulatedComputeUnits) ||
    prepared.simulatedComputeUnits <= 0 ||
    prepared.computeUnitLimit <
      Math.ceil(prepared.simulatedComputeUnits * COMPUTE_UNIT_SAFETY_MULTIPLIER) ||
    prepared.serializedSizeBytes > PACKET_LIMIT_BYTES
  ) {
    throw new Error("Prepared batch validation failed.");
  }

  const uniqueAddresses = new Set<string>();

  for (const item of prepared.accounts) {
    if (item.tokenProgram !== "SPL Token" && item.tokenProgram !== "Token-2022") {
      throw new Error("Prepared batch contains an unsupported token program.");
    }

    let address: PublicKey;

    try {
      address = new PublicKey(item.address);
    } catch {
      throw new Error("Prepared batch contains an invalid account address.");
    }

    if (
      address.toBase58() !== item.address ||
      typeof item.rentLamports !== "bigint" ||
      item.rentLamports <= BigInt(0) ||
      typeof item.withheldAmount !== "bigint" ||
      item.withheldAmount < BigInt(0) ||
      typeof item.tokenAmount !== "bigint" ||
      item.tokenAmount < BigInt(0) ||
      !Number.isInteger(item.mintDecimals) ||
      item.mintDecimals < 0 ||
      item.mintDecimals > 255 ||
      (item.withheldAmount > BigInt(0) && item.tokenProgram !== "Token-2022") ||
      new PublicKey(item.mintAddress).toBase58() !== item.mintAddress
    ) {
      throw new Error("Prepared batch contains invalid account metadata.");
    }

    uniqueAddresses.add(item.address);
  }

  if (uniqueAddresses.size !== prepared.accounts.length) {
    throw new Error("Prepared batch contains duplicate accounts.");
  }

  if (
    typeof prepared.estimatedNetworkFeeLamports !== "bigint" ||
    prepared.estimatedNetworkFeeLamports < BigInt(0) ||
    prepared.estimatedNetworkFeeLamports > BigInt(Number.MAX_SAFE_INTEGER) ||
    !Number.isSafeInteger(prepared.lastValidBlockHeight) ||
    prepared.lastValidBlockHeight < 0 ||
    prepared.blockhash !== prepared.transaction.message.recentBlockhash
  ) {
    throw new Error("Prepared batch contains invalid transaction metadata.");
  }

  const gross = prepared.accounts.reduce((sum, item) => sum + item.rentLamports, BigInt(0));

  const fee = (gross * BigInt(expectedServiceFeeBps)) / BigInt(10_000);

  if (
    gross !== prepared.grossRentLamports ||
    fee !== prepared.serviceFeeLamports ||
    fee <= BigInt(0) ||
    prepared.estimatedNetRecoveredLamports !== gross - fee
  ) {
    throw new Error("Prepared batch fee validation failed.");
  }

  const harvestSourcesByMint = new Map<string, string[]>();
  for (const account of prepared.accounts) {
    if (account.withheldAmount <= BigInt(0)) continue;
    const sources = harvestSourcesByMint.get(account.mintAddress) ?? [];
    sources.push(account.address);
    harvestSourcesByMint.set(account.mintAddress, sources);
  }
  const expectedHarvestInstructions = [...harvestSourcesByMint.entries()].map(
    ([mintAddress, sources]) =>
      createHarvestWithheldTokensToMintInstruction(
        new PublicKey(mintAddress),
        sources.map((source) => new PublicKey(source)),
        TOKEN_2022_PROGRAM_ID,
      ),
  );

  const expectedInstructions = [
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 0,
    }),
    ComputeBudgetProgram.setComputeUnitLimit({
      units: prepared.computeUnitLimit,
    }),
    ...expectedHarvestInstructions,
    ...prepared.accounts
      .filter((item) => item.tokenAmount > BigInt(0))
      .map((item) =>
        createBurnCheckedInstruction(
          new PublicKey(item.address),
          new PublicKey(item.mintAddress),
          wallet,
          item.tokenAmount,
          item.mintDecimals,
          [],
          item.tokenProgram === "SPL Token" ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
        ),
      ),
    ...prepared.accounts.map((item) =>
      createCloseAccountInstruction(
        new PublicKey(item.address),
        wallet,
        wallet,
        [],
        item.tokenProgram === "SPL Token" ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
      ),
    ),
    SystemProgram.transfer({
      fromPubkey: wallet,
      toPubkey: treasury,
      lamports: Number(fee),
    }),
  ];

  const expectedMessage = new TransactionMessage({
    payerKey: wallet,
    recentBlockhash: prepared.blockhash,
    instructions: expectedInstructions,
  }).compileToLegacyMessage();

  const actualMessage = prepared.transaction.message;

  if (!Buffer.from(actualMessage.serialize()).equals(Buffer.from(expectedMessage.serialize()))) {
    throw new Error("Batch contains unexpected transaction instructions.");
  }

  const actualSize = prepared.transaction.serialize().length;

  if (actualSize !== prepared.serializedSizeBytes || actualSize > PACKET_LIMIT_BYTES) {
    throw new Error("Batch serialized size validation failed.");
  }
}

/**
 * Validates selected accounts and groups them by transaction size
 * and configured compute budget. No final transaction is prepared here.
 */
export async function planCloseAccountBatches(
  config: BatchPreparationConfig,
): Promise<BatchAccount[][]> {
  const { wallet, treasury } = validateConfig(
    config.walletAddress,
    config.treasuryAddress,
    config.serviceFeeBps,
  );

  if (config.accountAddresses.length === 0) {
    throw new Error("Select at least one account.");
  }

  const uniqueAddresses = [...new Set(config.accountAddresses)];

  if (uniqueAddresses.length !== config.accountAddresses.length) {
    throw new Error("Selected accounts contain duplicates.");
  }

  const harvestConsent = new Set(config.harvestAccountAddresses ?? []);
  if (harvestConsent.size !== (config.harvestAccountAddresses ?? []).length) {
    throw new Error("Harvest consent contains duplicate account addresses.");
  }

  const burnConsent = new Set(config.burnAccountAddresses ?? []);
  if (burnConsent.size !== (config.burnAccountAddresses ?? []).length) {
    throw new Error("Burn consent contains duplicate account addresses.");
  }

  const inspected = await mapWithConcurrency(
    uniqueAddresses,
    MAX_ACCOUNT_INSPECTION_CONCURRENCY,
    async (addressString) => {
    const inspectedAccount = await inspectAccount(
      wallet,
      new PublicKey(addressString),
      config.connection,
      burnConsent.has(addressString),
    );
    if (inspectedAccount.tokenAmount > BigInt(0) && !burnConsent.has(addressString)) {
      throw new ClosePreparationError(
        "BURN_CONSENT_REQUIRED",
        `Account ${addressString} contains tokens. Explicit full-balance burn consent is required.`,
      );
    }
    if (inspectedAccount.withheldAmount > BigInt(0) && !harvestConsent.has(addressString)) {
      throw new ClosePreparationError(
        "WITHHELD_FEES_CONSENT_REQUIRED",
        `Account ${addressString} has withheld fees. Rescan and explicitly acknowledge mint harvesting before selecting it.`,
      );
    }
      return inspectedAccount;
    },
  );

  // A blockhash is needed only to measure serialized transaction size.
  // It is deliberately not reused for the final transactions.
  const sizingBlockhash = PublicKey.default.toBase58();

  const groups: BatchAccount[][] = [];
  let current: BatchAccount[] = [];

  for (const account of inspected) {
    if (current.length >= MAX_ACCOUNTS_PER_TRANSACTION) {
      groups.push(current);
      current = [];
    }

    const candidate = [...current, account];

    const candidateGross = candidate.reduce((sum, item) => sum + item.rentLamports, BigInt(0));

    const candidateFee = (candidateGross * BigInt(config.serviceFeeBps)) / BigInt(10_000);

    const harvestSourceCount = candidate.filter((item) => item.withheldAmount > BigInt(0)).length;
    const burnCount = candidate.filter((item) => item.tokenAmount > BigInt(0)).length;
    const estimatedComputeUnits =
      candidate.length * COMPUTE_UNITS_PER_CLOSE +
      harvestSourceCount * COMPUTE_UNITS_PER_HARVEST +
      burnCount * 100_000;
    const computeFits = estimatedComputeUnits <= MAX_COMPUTE_UNITS;

    let sizeFits = false;

    if (computeFits && candidateFee > BigInt(0)) {
      try {
        const candidateTransaction = buildTransaction(
          wallet,
          treasury,
          candidate,
          candidateFee,
          sizingBlockhash,
          estimatedComputeUnits,
        );

        sizeFits = candidateTransaction.serialize().length <= PACKET_LIMIT_BYTES;
      } catch {
        sizeFits = false;
      }
    }

    if (computeFits && sizeFits) {
      current = candidate;
      continue;
    }

    if (current.length === 0) {
      throw new Error(`Account ${account.address} cannot fit into a valid transaction batch.`);
    }

    groups.push(current);
    current = [account];

    const singleFee = (account.rentLamports * BigInt(config.serviceFeeBps)) / BigInt(10_000);

    if (singleFee <= BigInt(0)) {
      throw new Error(`Account ${account.address} produces no service fee at the configured rate.`);
    }

    const singleTransaction = buildTransaction(
      wallet,
      treasury,
      current,
      singleFee,
      sizingBlockhash,
      COMPUTE_UNITS_PER_CLOSE +
        (account.withheldAmount > BigInt(0) ? COMPUTE_UNITS_PER_HARVEST : 0) +
        (account.tokenAmount > BigInt(0) ? 100_000 : 0),
    );

    if (singleTransaction.serialize().length > PACKET_LIMIT_BYTES) {
      throw new Error(`Account ${account.address} cannot fit into a transaction.`);
    }
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

/**
 * Revalidates one planned group, simulates it, estimates the network fee,
 * and prepares an unsigned transaction with a fresh preview blockhash.
 * A second fresh blockhash is obtained after user approval for signing.
 */
export async function prepareCloseAccountBatch(
  config: BatchPreparationConfig,
  plannedAccounts: BatchAccount[],
  batchIndex: number,
): Promise<PreparedCloseBatch> {
  const { wallet, treasury } = validateConfig(
    config.walletAddress,
    config.treasuryAddress,
    config.serviceFeeBps,
  );

  if (plannedAccounts.length === 0) {
    throw new Error("Cannot prepare an empty batch.");
  }

  if (plannedAccounts.length > MAX_ACCOUNTS_PER_TRANSACTION) {
    throw new Error(`A transaction cannot contain more than ${MAX_ACCOUNTS_PER_TRANSACTION} token accounts.`);
  }

  const uniqueAddresses = new Set(plannedAccounts.map((item) => item.address));

  if (uniqueAddresses.size !== plannedAccounts.length) {
    throw new Error("Planned batch contains duplicate accounts.");
  }

  // Re-read accounts concurrently; no blockhash is requested during these reads.
  const accounts = await mapWithConcurrency(
    plannedAccounts,
    MAX_ACCOUNT_INSPECTION_CONCURRENCY,
    async (planned) => {
    const current = await inspectAccount(
      wallet,
      new PublicKey(planned.address),
      config.connection,
      (config.burnAccountAddresses ?? []).includes(planned.address),
    );

    if (
      current.tokenAmount > BigInt(0) &&
      !(config.burnAccountAddresses ?? []).includes(planned.address)
    ) {
      throw new ClosePreparationError(
        "BURN_CONSENT_REQUIRED",
        `Account ${planned.address} requires explicit consent to burn its full token balance.`,
      );
    }

    if (
      current.tokenAmount !== planned.tokenAmount ||
      current.mintDecimals !== planned.mintDecimals
    ) {
      throw new ClosePreparationError(
        "TOKEN_BALANCE_CHANGED",
        `Token balance or mint decimals changed for ${planned.address}. Rescan and select again.`,
      );
    }

    if (
      current.withheldAmount > BigInt(0) &&
      !(config.harvestAccountAddresses ?? []).includes(planned.address)
    ) {
      throw new ClosePreparationError(
        "WITHHELD_FEES_CONSENT_REQUIRED",
        `Account ${planned.address} requires explicit consent to harvest fees to its mint.`,
      );
    }

    if (current.withheldAmount > BigInt(0) && planned.withheldAmount <= BigInt(0)) {
      throw new ClosePreparationError(
        "WITHHELD_FEES_CHANGED",
        `Account ${planned.address} acquired withheld fees after selection. Rescan and explicitly select it for harvest.`,
      );
    }

    if (current.tokenProgram !== planned.tokenProgram) {
      throw new Error(`Token program changed for account ${planned.address}.`);
    }

      return current;
    },
  );

  const grossRentLamports = accounts.reduce((sum, item) => sum + item.rentLamports, BigInt(0));

  const serviceFeeLamports = (grossRentLamports * BigInt(config.serviceFeeBps)) / BigInt(10_000);

  if (serviceFeeLamports <= BigInt(0)) {
    throw new Error(`Batch ${batchIndex + 1} produces no service fee at the configured rate.`);
  }

  const estimatedNetRecoveredLamports = grossRentLamports - serviceFeeLamports;

  // The simulation replaces the recent blockhash and does not need a live one.
  // Keep all potentially slow preparation work ahead of the final blockhash.
  const simulationBlockhash = PublicKey.default.toBase58();

  // Simulate with the maximum supported compute budget first. This is a
  // read-only RPC simulation: no wallet signature is attached or submitted.
  const simulationTransaction = buildTransaction(
    wallet,
    treasury,
    accounts,
    serviceFeeLamports,
    simulationBlockhash,
    MAX_COMPUTE_UNITS,
  );

  const simulation = await config.connection.simulateTransaction(simulationTransaction, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
  });

  if (simulation.value.err !== null) {
    throw new ClosePreparationError(
      "SIMULATION_FAILED",
      `Batch ${batchIndex + 1} simulation failed: ${JSON.stringify(simulation.value.err)}`,
      simulation.value.logs ?? [],
    );
  }

  const simulatedComputeUnits = simulation.value.unitsConsumed;

  if (
    typeof simulatedComputeUnits !== "number" ||
    !Number.isSafeInteger(simulatedComputeUnits) ||
    simulatedComputeUnits <= 0
  ) {
    throw new ClosePreparationError(
      "COMPUTE_UNITS_UNAVAILABLE",
      `Batch ${batchIndex + 1} simulation did not return valid compute-unit usage.`,
      simulation.value.logs ?? [],
    );
  }

  const computeUnitLimit = Math.ceil(simulatedComputeUnits * COMPUTE_UNIT_SAFETY_MULTIPLIER);

  if (computeUnitLimit > MAX_COMPUTE_UNITS) {
    throw new Error(
      `Batch ${batchIndex + 1} exceeds the maximum compute-unit budget after applying the safety margin.`,
    );
  }

  // Build the wallet-facing transaction with a measured CU limit and a
  // 20% margin, rather than the old fixed per-account estimate.
  const transaction = buildTransaction(
    wallet,
    treasury,
    accounts,
    serviceFeeLamports,
    simulationBlockhash,
    computeUnitLimit,
  );

  const serializedSizeBytes = transaction.serialize().length;

  if (serializedSizeBytes > PACKET_LIMIT_BYTES) {
    throw new Error(`Batch ${batchIndex + 1} exceeds the Solana packet size limit.`);
  }

  const feeBlockhash = await config.connection.getLatestBlockhash("confirmed");
  const feeEstimateTransaction = buildTransaction(
    wallet,
    treasury,
    accounts,
    serviceFeeLamports,
    feeBlockhash.blockhash,
    computeUnitLimit,
  );
  const feeResponse = await config.connection.getFeeForMessage(
    feeEstimateTransaction.message,
    "confirmed",
  );

  if (feeResponse.value === null) {
    throw new ClosePreparationError(
      "FEE_UNAVAILABLE",
      `RPC could not estimate network fee for batch ${batchIndex + 1}.`,
    );
  }

  const latestBlockhash = await config.connection.getLatestBlockhash("confirmed");
  const transactionWithFreshBlockhash = buildTransaction(
    wallet,
    treasury,
    accounts,
    serviceFeeLamports,
    latestBlockhash.blockhash,
    computeUnitLimit,
  );
  const freshSerializedSizeBytes = transactionWithFreshBlockhash.serialize().length;
  if (freshSerializedSizeBytes > PACKET_LIMIT_BYTES) {
    throw new Error(`Batch ${batchIndex + 1} exceeds the Solana packet size limit.`);
  }

  const batch: PreparedCloseBatch = {
    batchIndex,
    accounts,
    destinationAddress: wallet.toBase58(),
    treasuryAddress: treasury.toBase58(),
    serviceFeeBps: config.serviceFeeBps,
    grossRentLamports,
    serviceFeeLamports,
    estimatedNetRecoveredLamports,
    estimatedNetworkFeeLamports: BigInt(feeResponse.value),
    computeUnitLimit,
    simulatedComputeUnits,
    serializedSizeBytes: freshSerializedSizeBytes,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    transaction: transactionWithFreshBlockhash,
  };

  validatePreparedCloseBatch(batch, wallet.toBase58(), config.serviceFeeBps, treasury.toBase58());

  return batch;
}

/**
 * Revalidates the reviewed batch after user approval and replaces its blockhash
 * immediately before handing the transaction to the wallet. No simulation is
 * repeated: the instruction set and account state must still match the reviewed
 * and simulated batch exactly.
 */
export async function refreshPreparedCloseBatchForSigning(
  config: BatchPreparationConfig,
  prepared: PreparedCloseBatch,
): Promise<PreparedCloseBatch> {
  const { wallet, treasury } = validateConfig(
    config.walletAddress,
    config.treasuryAddress,
    config.serviceFeeBps,
  );

  validatePreparedCloseBatch(
    prepared,
    wallet.toBase58(),
    config.serviceFeeBps,
    treasury.toBase58(),
  );

  const accounts = await mapWithConcurrency(
    prepared.accounts,
    MAX_ACCOUNT_INSPECTION_CONCURRENCY,
    async (reviewed) => {
    const current = await inspectAccount(
      wallet,
      new PublicKey(reviewed.address),
      config.connection,
      (config.burnAccountAddresses ?? []).includes(reviewed.address),
    );

    if (
      current.tokenProgram !== reviewed.tokenProgram ||
      current.rentLamports !== reviewed.rentLamports ||
      current.mintAddress !== reviewed.mintAddress ||
      current.withheldAmount !== reviewed.withheldAmount ||
      current.tokenAmount !== reviewed.tokenAmount ||
      current.mintDecimals !== reviewed.mintDecimals
    ) {
      throw new ClosePreparationError(
        "ACCOUNT_NOT_EMPTY",
        `Account ${reviewed.address} changed after review. Rescan and review the batch again.`,
      );
    }

    if (
      current.withheldAmount > BigInt(0) &&
      !(config.harvestAccountAddresses ?? []).includes(reviewed.address)
    ) {
      throw new ClosePreparationError(
        "WITHHELD_FEES_CONSENT_REQUIRED",
        `Account ${reviewed.address} requires explicit harvest consent.`,
      );
    }

      return current;
    },
  );

  const grossRentLamports = accounts.reduce(
    (sum, account) => sum + account.rentLamports,
    BigInt(0),
  );
  const serviceFeeLamports =
    (grossRentLamports * BigInt(config.serviceFeeBps)) / BigInt(10_000);

  if (
    grossRentLamports !== prepared.grossRentLamports ||
    serviceFeeLamports !== prepared.serviceFeeLamports
  ) {
    throw new Error("The reviewed recovery amount changed. Review the batch again before signing.");
  }

  // This is deliberately the final RPC request before local validation and wallet signing.
  const latestBlockhash = await config.connection.getLatestBlockhash("confirmed");
  const transaction = buildTransaction(
    wallet,
    treasury,
    accounts,
    serviceFeeLamports,
    latestBlockhash.blockhash,
    prepared.computeUnitLimit,
  );
  const serializedSizeBytes = transaction.serialize().length;

  if (serializedSizeBytes > PACKET_LIMIT_BYTES) {
    throw new Error("Refreshed batch exceeds the Solana packet size limit.");
  }

  const refreshed: PreparedCloseBatch = {
    ...prepared,
    accounts,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    transaction,
    serializedSizeBytes,
  };

  validatePreparedCloseBatch(
    refreshed,
    wallet.toBase58(),
    config.serviceFeeBps,
    treasury.toBase58(),
  );

  return refreshed;
}

/**
 * Compatibility helper. Prepares all batches sequentially, each with
 * fresh account reads and its own blockhash.
 *
 * For interactive signing, prefer planCloseAccountBatches() followed by
 * prepareCloseAccountBatch() immediately before each wallet interaction.
 */
export async function prepareCloseAccountBatches(
  config: BatchPreparationConfig,
): Promise<PreparedCloseBatch[]> {
  const groups = await planCloseAccountBatches(config);
  const prepared: PreparedCloseBatch[] = [];

  for (let index = 0; index < groups.length; index += 1) {
    prepared.push(await prepareCloseAccountBatch(config, groups[index], index));
  }

  return prepared;
}