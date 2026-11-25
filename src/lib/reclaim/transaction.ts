import {
  createCloseAccountInstruction,
  getTransferFeeAmount,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
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

export type ClosePreparationErrorCode =
  | "ACCOUNT_NOT_FOUND"
  | "UNSUPPORTED_PROGRAM"
  | "ACCOUNT_NOT_INITIALIZED"
  | "ACCOUNT_NOT_EMPTY"
  | "BURN_CONSENT_REQUIRED"
  | "BURN_AUTHORITY_MISMATCH"
  | "BURN_MINT_INVALID"
  | "BURN_MINT_DECIMALS_INVALID"
  | "TOKEN_BALANCE_CHANGED"
  | "NATIVE_ACCOUNT"
  | "FROZEN_ACCOUNT"
  | "AUTHORITY_MISMATCH"
  | "WITHHELD_FEES"
  | "WITHHELD_MINT_INVALID"
  | "WITHHELD_MINT_CONFIG_MISSING"
  | "WITHHELD_FEES_CHANGED"
  | "WITHHELD_FEES_CONSENT_REQUIRED"
  | "UNSUPPORTED_EXTENSION"
  | "FEE_UNAVAILABLE"
  | "SIMULATION_FAILED"
  | "COMPUTE_UNITS_UNAVAILABLE";

export class ClosePreparationError extends Error {
  constructor(
    public readonly code: ClosePreparationErrorCode,
    message: string,
    public readonly logs: string[] = [],
  ) {
    super(message);
    this.name = "ClosePreparationError";
  }
}

export type PreparedCloseAccount = {
  accountAddress: string;
  destinationAddress: string;
  tokenProgram: "SPL Token" | "Token-2022";
  rentLamports: bigint;
  treasuryAddress: string;
  serviceFeeBps: number;
  serviceFeeLamports: bigint;
  estimatedNetRecoveredLamports: bigint;
  estimatedNetworkFeeLamports: bigint;
  computeUnitLimit: number;
  blockhash: string;
  lastValidBlockHeight: number;
  transaction: VersionedTransaction;
};

/**
 * Проверяет точный состав транзакции:
 * нулевая priority fee, ожидаемый лимит CU и один CloseAccount.
 */
export function validatePreparedCloseAccount(
  prepared: PreparedCloseAccount,
  walletAddress: string,
  expectedServiceFeeBps: number,
  expectedTreasuryAddress: string,
): void {
  const wallet = new PublicKey(walletAddress);
  const treasury = new PublicKey(prepared.treasuryAddress);
  const expectedTreasury = new PublicKey(expectedTreasuryAddress);

  if (
    !treasury.equals(expectedTreasury) ||
    expectedTreasury.equals(PublicKey.default) ||
    expectedTreasury.equals(wallet)
  ) {
    throw new Error("Prepared transaction treasury validation failed.");
  }
  const expectedProgram =
    prepared.tokenProgram === "SPL Token" ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

  if (
    treasury.equals(PublicKey.default) ||
    treasury.equals(wallet) ||
    prepared.destinationAddress !== walletAddress ||
    !Number.isSafeInteger(expectedServiceFeeBps) ||
    expectedServiceFeeBps < 1 ||
    expectedServiceFeeBps >= 10_000 ||
    prepared.serviceFeeBps !== expectedServiceFeeBps ||
    !Number.isSafeInteger(prepared.serviceFeeBps) ||
    prepared.serviceFeeBps < 1 ||
    prepared.serviceFeeBps >= 10_000 ||
    prepared.rentLamports <= BigInt(0) ||
    prepared.serviceFeeLamports !==
      (prepared.rentLamports * BigInt(prepared.serviceFeeBps)) / BigInt(10000) ||
    prepared.serviceFeeLamports <= BigInt(0) ||
    prepared.estimatedNetRecoveredLamports !==
      prepared.rentLamports - prepared.serviceFeeLamports ||
    prepared.serviceFeeLamports > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("Prepared transaction fee validation failed.");
  }

  const message = TransactionMessage.decompile(prepared.transaction.message);

  if (
    !message.payerKey.equals(wallet) ||
    message.recentBlockhash !== prepared.blockhash ||
    message.instructions.length !== 4 ||
    !Number.isSafeInteger(prepared.computeUnitLimit) ||
    prepared.computeUnitLimit <= 0 ||
    prepared.computeUnitLimit > 1_400_000
  ) {
    throw new Error("Prepared transaction validation failed.");
  }

  const expectedPriceInstruction = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 });

  const expectedLimitInstruction = ComputeBudgetProgram.setComputeUnitLimit({
    units: prepared.computeUnitLimit,
  });

  const expectedCloseInstruction = createCloseAccountInstruction(
    new PublicKey(prepared.accountAddress),
    wallet,
    wallet,
    [],
    expectedProgram,
  );

  const expectedTransferInstruction = SystemProgram.transfer({
    fromPubkey: wallet,
    toPubkey: treasury,
    lamports: Number(prepared.serviceFeeLamports),
  });

  // Сравниваем целиком скомпилированное сообщение.
  // Компилятор Solana объединяет права аккаунтов между инструкциями,
  // поэтому локальные флаги исходных инструкций сравнивать некорректно.
  const expectedMessage = new TransactionMessage({
    payerKey: wallet,
    recentBlockhash: prepared.blockhash,
    instructions: [
      expectedPriceInstruction,
      expectedLimitInstruction,
      expectedCloseInstruction,
      expectedTransferInstruction,
    ],
  }).compileToLegacyMessage();

  if (
    !Buffer.from(prepared.transaction.message.serialize()).equals(
      Buffer.from(expectedMessage.serialize()),
    )
  ) {
    throw new Error("Transaction contains unexpected instructions.");
  }
}

/**
 * Re-reads and validates one token account, creates an unsigned
 * CloseAccount transaction without simulating or signing it.
 *
 * This function NEVER signs or sends a transaction.
 */
export async function prepareCloseAccount(
  walletAddress: string,
  accountAddress: string,
  connection: Connection,
  treasuryAddress: string,
  serviceFeeBps: number,
): Promise<PreparedCloseAccount> {
  const wallet = new PublicKey(walletAddress);
  const account = new PublicKey(accountAddress);
  const treasury = new PublicKey(treasuryAddress);
  const commitment = "confirmed" as const;

  if (
    treasury.equals(PublicKey.default) ||
    treasury.equals(wallet) ||
    !Number.isSafeInteger(serviceFeeBps) ||
    serviceFeeBps < 1 ||
    serviceFeeBps >= 10_000
  ) {
    throw new Error("Invalid service fee configuration or treasury address.");
  }

  const accountInfo = await connection.getAccountInfo(account, commitment);

  if (!accountInfo) {
    throw new ClosePreparationError("ACCOUNT_NOT_FOUND", "The token account no longer exists.");
  }

  let tokenProgramId: PublicKey;
  let tokenProgram: PreparedCloseAccount["tokenProgram"];

  if (accountInfo.owner.equals(TOKEN_PROGRAM_ID)) {
    tokenProgramId = TOKEN_PROGRAM_ID;
    tokenProgram = "SPL Token";
  } else if (accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    tokenProgramId = TOKEN_2022_PROGRAM_ID;
    tokenProgram = "Token-2022";
  } else {
    throw new ClosePreparationError(
      "UNSUPPORTED_PROGRAM",
      "The account is not owned by a supported token program.",
    );
  }

  const parsed = unpackAccount(account, accountInfo, tokenProgramId);

  if (!parsed.isInitialized) {
    throw new ClosePreparationError(
      "ACCOUNT_NOT_INITIALIZED",
      "The token account is not initialized.",
    );
  }

  if (parsed.isNative) {
    throw new ClosePreparationError(
      "NATIVE_ACCOUNT",
      "Wrapped SOL accounts are excluded from this recovery flow.",
    );
  }

  if (parsed.amount !== BigInt(0)) {
    throw new ClosePreparationError(
      "ACCOUNT_NOT_EMPTY",
      "The token account has a non-zero token balance.",
    );
  }

  if (parsed.isFrozen) {
    throw new ClosePreparationError(
      "FROZEN_ACCOUNT",
      "Frozen token accounts are excluded from the MVP.",
    );
  }

  const effectiveCloseAuthority = parsed.closeAuthority ?? parsed.owner;

  if (!effectiveCloseAuthority.equals(wallet)) {
    throw new ClosePreparationError(
      "AUTHORITY_MISMATCH",
      "The connected wallet is not the effective close authority.",
    );
  }

  const accountExtensions = tokenProgramId.equals(TOKEN_2022_PROGRAM_ID)
    ? parseExtensionTypesSafe(parsed.tlvData)
    : [];

  const extensionEvaluation = evaluateAccountExtensions(accountExtensions);

  if (!extensionEvaluation.allowed) {
    throw new ClosePreparationError(
      "UNSUPPORTED_EXTENSION",
      extensionEvaluation.unsupportedName
        ? `Unsupported Token-2022 extension: ${extensionEvaluation.unsupportedName}`
        : "The account contains an unsupported extension.",
    );
  }

  const transferFee = tokenProgramId.equals(TOKEN_2022_PROGRAM_ID)
    ? getTransferFeeAmount(parsed)
    : null;

  const withheldAmount = transferFee?.withheldAmount ?? BigInt(0);

  if (withheldAmount > BigInt(0)) {
    throw new ClosePreparationError(
      "WITHHELD_FEES",
      "The account contains withheld transfer fees.",
    );
  }

  // The account rent is released first; the service fee is transferred second.
  const rentLamports = BigInt(accountInfo.lamports);
  const serviceFeeLamports = (rentLamports * BigInt(serviceFeeBps)) / BigInt(10000);
  const estimatedNetRecoveredLamports = rentLamports - serviceFeeLamports;

  if (
    rentLamports <= BigInt(0) ||
    serviceFeeLamports <= BigInt(0) ||
    serviceFeeLamports > BigInt(Number.MAX_SAFE_INTEGER) ||
    estimatedNetRecoveredLamports <= BigInt(0)
  ) {
    throw new Error("The account balance is too small for the configured service fee.");
  }

  const closeInstruction = createCloseAccountInstruction(
    account,
    wallet,
    wallet,
    [],
    tokenProgramId,
  );

  const transferFeeInstruction = SystemProgram.transfer({
    fromPubkey: wallet,
    toPubkey: treasury,
    lamports: Number(serviceFeeLamports),
  });

  const latestBlockhash = await connection.getLatestBlockhash(commitment);

  // Fixed CU limit for one CloseAccount + service-fee transfer.
  // This is a configured limit, not a simulated CU measurement.
  const priceInstruction = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 });

  const computeUnitLimit = 100_000;

  const limitInstruction = ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit });

  const finalMessage = new TransactionMessage({
    payerKey: wallet,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: [priceInstruction, limitInstruction, closeInstruction, transferFeeInstruction],
  }).compileToLegacyMessage();

  // The final transaction remains unsigned.
  const transaction = new VersionedTransaction(finalMessage);

  const feeResponse = await connection.getFeeForMessage(finalMessage, commitment);

  if (feeResponse.value === null) {
    throw new ClosePreparationError(
      "FEE_UNAVAILABLE",
      "The RPC endpoint could not estimate the transaction fee.",
    );
  }

  return {
    accountAddress: account.toBase58(),
    destinationAddress: wallet.toBase58(),
    tokenProgram,
    rentLamports,
    treasuryAddress: treasury.toBase58(),
    serviceFeeBps,
    serviceFeeLamports,
    estimatedNetRecoveredLamports,
    estimatedNetworkFeeLamports: BigInt(feeResponse.value),
    computeUnitLimit,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    transaction,
  };
}