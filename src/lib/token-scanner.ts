import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getExtensionTypes,
  unpackAccount,
} from "@solana/spl-token";

import type { Connection, PublicKey } from "@solana/web3.js";

export type TokenProgram = "SPL Token" | "Token-2022";

export interface ScannedTokenAccount {
  address: string;
  mint: string;
  owner: string;
  program: TokenProgram;
  programId: string;
  amount: string;
  isEmpty: boolean;
  isInitialized: boolean;
  isFrozen: boolean;
  closeAuthority: string | null;
  extensions: string[];
  lamports: number;
  closeableCandidate: boolean;
  reviewReasons: string[];
}

export interface TokenScanResult {
  wallet: string;
  scannedAt: string;
  totalAccounts: number;
  emptyAccounts: number;
  closeableCandidates: number;
  potentialLamports: string;
  accounts: ScannedTokenAccount[];
}

function getExtensionNames(
  extensionTypes: ExtensionType[],
): string[] {
  return extensionTypes.map((extension) => {
    return String(
      ExtensionType[extension] ?? `Unknown(${extension})`,
    );
  });
}

async function scanProgram(
  connection: Connection,
  wallet: PublicKey,
  programId: PublicKey,
  program: TokenProgram,
): Promise<ScannedTokenAccount[]> {
  const response = await connection.getTokenAccountsByOwner(
    wallet,
    { programId },
    "confirmed",
  );

  return response.value.map(({ pubkey, account: accountInfo }) => {
    const account = unpackAccount(
      pubkey,
      accountInfo,
      programId,
    );

    const isEmpty = account.amount === BigInt(0);

    const extensions =
      programId.equals(TOKEN_2022_PROGRAM_ID)
        ? getExtensionNames(getExtensionTypes(account.tlvData))
        : [];

    const reviewReasons: string[] = [];

    if (!isEmpty) {
      reviewReasons.push("Token balance is not zero");
    }

    if (!account.isInitialized) {
      reviewReasons.push("Account is not initialized");
    }

    if (account.isFrozen) {
      reviewReasons.push("Account is frozen");
    }

    if (
      account.closeAuthority !== null &&
      !account.closeAuthority.equals(wallet)
    ) {
      reviewReasons.push("Close authority belongs to another address");
    }

    if (extensions.length > 0) {
      reviewReasons.push(
        "Token-2022 extensions require additional safety checks",
      );
    }

    const closeableCandidate =
      isEmpty &&
      account.isInitialized &&
      !account.isFrozen &&
      (account.closeAuthority === null ||
        account.closeAuthority.equals(wallet)) &&
      extensions.length === 0;

    return {
      address: pubkey.toBase58(),
      mint: account.mint.toBase58(),
      owner: account.owner.toBase58(),
      program,
      programId: programId.toBase58(),
      amount: account.amount.toString(),
      isEmpty,
      isInitialized: account.isInitialized,
      isFrozen: account.isFrozen,
      closeAuthority: account.closeAuthority?.toBase58() ?? null,
      extensions,
      lamports: accountInfo.lamports,
      closeableCandidate,
      reviewReasons,
    };
  });
}

export async function scanTokenAccounts(
  connection: Connection,
  wallet: PublicKey,
): Promise<TokenScanResult> {
  const [splAccounts, token2022Accounts] = await Promise.all([
    scanProgram(
      connection,
      wallet,
      TOKEN_PROGRAM_ID,
      "SPL Token",
    ),
    scanProgram(
      connection,
      wallet,
      TOKEN_2022_PROGRAM_ID,
      "Token-2022",
    ),
  ]);

  const accounts = [...splAccounts, ...token2022Accounts].sort(
    (a, b) => b.lamports - a.lamports,
  );

  const closeableAccounts = accounts.filter(
    (account) => account.closeableCandidate,
  );

  const potentialLamports = closeableAccounts.reduce(
    (total, account) => total + BigInt(account.lamports),
    BigInt(0),
  );

  return {
    wallet: wallet.toBase58(),
    scannedAt: new Date().toISOString(),
    totalAccounts: accounts.length,
    emptyAccounts: accounts.filter((account) => account.isEmpty).length,
    closeableCandidates: closeableAccounts.length,
    potentialLamports: potentialLamports.toString(),
    accounts,
  };
}