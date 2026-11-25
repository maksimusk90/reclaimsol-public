import {
  getTransferFeeAmount,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  type ExtensionType,
} from "@solana/spl-token";
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { evaluateAccountExtensions, extensionName, parseExtensionTypesSafe } from "./extensions";
import {
  ReclaimReasonCode,
  type AccountStatus,
  type ScanResult,
  type ScanRow,
  type TokenProgramName,
} from "./types";

type ClassificationInput = {
  isInitialized: boolean;
  isZero: boolean;
  isNative: boolean;
  isFrozen: boolean;
  hasAuthority: boolean;
  unsupportedExtensions: boolean;
  extensionReasonCode?: ReclaimReasonCode;
  withheldAmount: bigint;
};

export function classifyAccountState(input: ClassificationInput): {
  status: AccountStatus;
  reasonCode: ReclaimReasonCode;
  reason: string;
} {
  if (input.isNative) {
    return {
      status: "review_required",
      reasonCode: ReclaimReasonCode.WrappedSolUnsupported,
      reason: "Wrapped SOL accounts are excluded from the MVP scanner.",
    };
  }

  if (!input.isInitialized) {
    return {
      status: "review_required",
      reasonCode: ReclaimReasonCode.UninitializedAccount,
      reason: "Uninitialized token accounts require manual review.",
    };
  }

  if (input.isFrozen) {
    return {
      status: "review_required",
      reasonCode: ReclaimReasonCode.FrozenAccount,
      reason: "Frozen accounts require manual review in the MVP.",
    };
  }

  if (!input.hasAuthority) {
    return {
      status: "review_required",
      reasonCode: ReclaimReasonCode.InsufficientAuthority,
      reason: "The connected wallet is not the effective close authority.",
    };
  }

  if (input.unsupportedExtensions) {
    return {
      status: "unsupported",
      reasonCode: input.extensionReasonCode ?? ReclaimReasonCode.UnsupportedTokenExtension,
      reason:
        input.extensionReasonCode === ReclaimReasonCode.BlockedConfidentialExtension
          ? "Confidential Token-2022 extensions are blocked in the MVP."
          : "The account contains an unsupported or unknown Token-2022 extension.",
    };
  }

  if (!input.isZero) {
    return {
      status: "has_tokens",
      reasonCode: ReclaimReasonCode.NonzeroBalance,
      reason:
        input.withheldAmount > BigInt(0)
          ? "Non-zero token balance. Full balance burn and withheld-fee harvest are required before closing."
          : "Non-zero token balance. Full balance burn is required before closing.",
    };
  }

  if (input.withheldAmount > BigInt(0)) {
    return {
      status: "review_required",
      reasonCode: ReclaimReasonCode.WithheldTransferFee,
      reason:
        "Withheld Token-2022 fees can be harvested to the mint before closing; they are not returned to your wallet.",
    };
  }

  return {
    status: "reclaimable",
    reasonCode: ReclaimReasonCode.EmptyAccountEligible,
    reason: "Empty token account; supported state and close authority verified.",
  };
}

function makeScanErrorRow(address: string, program: TokenProgramName, lamports: bigint): ScanRow {
  return {
    address,
    mint: null,
    program,
    tokenAmount: null,
    withheldAmount: "0",
    lamports,
    status: "scan_error",
    reasonCode: ReclaimReasonCode.AccountStateUnknown,
    reason: "Account data could not be decoded safely. Excluded from recovery.",
    extensions: [],
  };
}

/**
 * Read-only wallet scan. It reads both canonical token programs and uses the
 * actual lamport balance of each account; it does not create transactions.
 */
export async function scanWallet(
  walletAddress: string,
  connection: Connection,
): Promise<ScanResult> {
  const wallet = new PublicKey(walletAddress);
  const commitment = "confirmed" as const;

  const [walletBalance, splAccounts, token2022Accounts] = await Promise.all([
    connection.getBalanceAndContext(wallet, commitment),
    connection.getTokenAccountsByOwner(wallet, { programId: TOKEN_PROGRAM_ID }, commitment),
    connection.getTokenAccountsByOwner(wallet, { programId: TOKEN_2022_PROGRAM_ID }, commitment),
  ]);

  const rows: ScanRow[] = [];
  let warnings = 0;

  const sources: Array<{
    program: TokenProgramName;
    programId: PublicKey;
    accounts: typeof splAccounts.value;
  }> = [
    {
      program: "SPL Token",
      programId: TOKEN_PROGRAM_ID,
      accounts: splAccounts.value,
    },
    {
      program: "Token-2022",
      programId: TOKEN_2022_PROGRAM_ID,
      accounts: token2022Accounts.value,
    },
  ];

  for (const source of sources) {
    for (const item of source.accounts) {
      const address = item.pubkey.toBase58();
      const lamports = BigInt(item.account.lamports);

      try {
        // Verify the RPC account owner before decoding with a program layout.
        if (!item.account.owner.equals(source.programId)) {
          warnings += 1;
          rows.push(makeScanErrorRow(address, source.program, lamports));
          continue;
        }

        const parsed = unpackAccount(
          item.pubkey,
          item.account as AccountInfo<Buffer>,
          source.programId,
        );

        const accountExtensions: ExtensionType[] =
          source.program === "Token-2022" ? parseExtensionTypesSafe(parsed.tlvData) : [];

        const extensionEvaluation = evaluateAccountExtensions(accountExtensions);
        const transferFee = source.program === "Token-2022" ? getTransferFeeAmount(parsed) : null;
        const withheldAmount = transferFee?.withheldAmount ?? BigInt(0);
        const effectiveCloseAuthority = parsed.closeAuthority ?? parsed.owner;

        const classification = classifyAccountState({
          isZero: parsed.amount === BigInt(0),
          isNative: parsed.isNative,
          isFrozen: parsed.isFrozen,
          isInitialized: parsed.isInitialized,
          hasAuthority: effectiveCloseAuthority.equals(wallet),
          unsupportedExtensions: !extensionEvaluation.allowed,
          extensionReasonCode: extensionEvaluation.code,
          withheldAmount,
        });

        rows.push({
          address,
          mint: parsed.mint.toBase58(),
          program: source.program,
          tokenAmount: parsed.amount.toString(),
          withheldAmount: withheldAmount.toString(),
          lamports,
          status: classification.status,
          reasonCode: classification.reasonCode,
          reason: extensionEvaluation.unsupportedName
            ? `${classification.reason} (${extensionEvaluation.unsupportedName})`
            : classification.reason,
          extensions: accountExtensions.map(extensionName),
        });
      } catch {
        warnings += 1;
        rows.push(makeScanErrorRow(address, source.program, lamports));
      }
    }
  }

  return {
    rows,
    walletLamports: BigInt(walletBalance.value),
    contextSlot: Math.min(
      walletBalance.context.slot,
      splAccounts.context.slot,
      token2022Accounts.context.slot,
    ),
    warnings,
  };
}

export function formatLamports(lamports: bigint): string {
  const negative = lamports < BigInt(0);
  const absolute = negative ? -lamports : lamports;
  const whole = absolute / BigInt(1000000000);
  const fraction = (absolute % BigInt(1000000000)).toString().padStart(9, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}