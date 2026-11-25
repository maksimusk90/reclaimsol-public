export enum ReclaimReasonCode {
  EmptyAccountEligible = "EMPTY_ACCOUNT_ELIGIBLE",
  UninitializedAccount = "UNINITIALIZED_ACCOUNT",
  NonzeroBalance = "NONZERO_BALANCE",
  FrozenAccount = "FROZEN_ACCOUNT",
  InsufficientAuthority = "INSUFFICIENT_AUTHORITY",
  UnsupportedTokenExtension = "UNSUPPORTED_TOKEN_EXTENSION",
  WithheldTransferFee = "WITHHELD_TRANSFER_FEE",
  WrappedSolUnsupported = "WRAPPED_SOL_UNSUPPORTED",
  AccountStateUnknown = "ACCOUNT_STATE_UNKNOWN",
  RpcError = "RPC_ERROR",
  BlockedConfidentialExtension = "BLOCKED_CONFIDENTIAL_EXTENSION",
}

export type AccountStatus =
  "reclaimable" | "has_tokens" | "review_required" | "unsupported" | "scan_error";

export type TokenProgramName = "SPL Token" | "Token-2022";

export type ScanRow = {
  address: string;
  mint: string | null;
  program: TokenProgramName;
  tokenAmount: string | null;
  withheldAmount: string;
  lamports: bigint;
  status: AccountStatus;
  reasonCode: ReclaimReasonCode;
  reason: string;
  extensions: string[];
};

export type ScanResult = {
  rows: ScanRow[];
  walletLamports: bigint;
  contextSlot: number;
  warnings: number;
};