import bs58 from "bs58";
import { ComputeBudgetProgram, SystemProgram, type VersionedTransaction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

type Message = VersionedTransaction["message"];

type MessageShape = {
  version?: string | number;
  recentBlockhash?: string;
  header?: {
    numRequiredSignatures?: number;
    numReadonlySignedAccounts?: number;
    numReadonlyUnsignedAccounts?: number;
  };
  staticAccountKeys?: Array<{ toBase58(): string }>;
  accountKeys?: Array<{ toBase58(): string }>;
  compiledInstructions?: Array<{
    programIdIndex: number;
    accountKeyIndexes: number[];
    data: Uint8Array | string;
  }>;
  instructions?: Array<{
    programIdIndex?: number;
    accounts?: number[];
    data: Uint8Array | string;
  }>;
  addressTableLookups?: Array<{
    accountKey: { toBase58(): string };
    writableIndexes: number[];
    readonlyIndexes: number[];
  }>;
};

function stable(value: unknown): string {
  if (value instanceof Uint8Array) {
    return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return JSON.stringify(value) ?? String(value);
}

function keys(message: MessageShape): string[] {
  const source = message.staticAccountKeys ?? message.accountKeys ?? [];
  return source.map((key) => key.toBase58());
}

function instructions(message: MessageShape) {
  return (
    message.compiledInstructions ??
    (message.instructions ?? []).map((instruction) => ({
      programIdIndex: instruction.programIdIndex ?? -1,
      accountKeyIndexes: instruction.accounts ?? [],
      data: instruction.data,
    }))
  );
}

const PROGRAM_LABELS = new Map<string, string>([
  [SystemProgram.programId.toBase58(), "System Program"],
  [ComputeBudgetProgram.programId.toBase58(), "Compute Budget Program"],
  [TOKEN_PROGRAM_ID.toBase58(), "SPL Token Program"],
  [TOKEN_2022_PROGRAM_ID.toBase58(), "Token-2022 Program"],
  [ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), "Associated Token Program"],
]);

function programName(address: string | undefined): string {
  if (!address) return "unknown program";
  const label = PROGRAM_LABELS.get(address);
  return label ? `${label} (${address})` : `Unknown program (${address})`;
}

function dataSummary(data: Uint8Array | string): string {
  if (typeof data === "string") {
    return `base58:${data.length > 96 ? `${data.slice(0, 96)}…` : data} (${data.length} chars)`;
  }
  const hex = Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `hex:${hex.length > 192 ? `${hex.slice(0, 192)}…` : hex} (${data.length} bytes)`;
}

function decodeComputeBudgetInstruction(program: string | undefined, data: Uint8Array | string): string | null {
  if (program !== ComputeBudgetProgram.programId.toBase58()) return null;
  let bytes: Uint8Array;
  try {
    bytes = typeof data === "string" ? bs58.decode(data) : data;
  } catch {
    return "Compute Budget instruction data could not be decoded";
  }
  if (bytes.length === 0) return "Compute Budget instruction has empty data";
  const tag = bytes[0];
  const readU32 = () => bytes.length === 5 ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, true) : null;
  if (tag === 0 && bytes.length === 9) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return `RequestUnitsDeprecated(units=${view.getUint32(1, true)}, additionalFee=${view.getUint32(5, true)} lamports)`;
  }
  if (tag === 1 && readU32() !== null) return `RequestHeapFrame(bytes=${readU32()})`;
  if (tag === 2 && readU32() !== null) return `SetComputeUnitLimit(units=${readU32()})`;
  if (tag === 3 && bytes.length === 9) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return `SetComputeUnitPrice(microLamports=${view.getBigUint64(1, true).toString()})`;
  }
  if (tag === 4 && readU32() !== null) return `SetLoadedAccountsDataSizeLimit(bytes=${readU32()})`;
  return `Unknown Compute Budget instruction(tag=${tag}, ${dataSummary(bytes)})`;
}

function accountRole(index: number, header: MessageShape["header"], keyCount: number): string {
  if (!header) return "role unavailable";
  const required = header.numRequiredSignatures ?? 0;
  const readonlySigned = header.numReadonlySignedAccounts ?? 0;
  const readonlyUnsigned = header.numReadonlyUnsignedAccounts ?? 0;
  if (index < required)
    return index < required - readonlySigned ? "signer+writable" : "signer+readonly";
  return index < keyCount - readonlyUnsigned ? "writable" : "readonly";
}

function instructionSummary(
  item: ReturnType<typeof instructions>[number],
  message: MessageShape,
  accountKeys: string[],
  index: number,
): string {
  const program = accountKeys[item.programIdIndex];
  const accountList = item.accountKeyIndexes.map((keyIndex) => {
    const address = accountKeys[keyIndex] ?? `missing-key-index-${keyIndex}`;
    return `${keyIndex}:${address}[${accountRole(keyIndex, message.header, accountKeys.length)}]`;
  });
  const decoded = decodeComputeBudgetInstruction(program, item.data);
  return `instruction ${index + 1}: ${programName(program)}; accounts=[${accountList.join(", ")}]; ${decoded ? `${decoded}; ` : ""}data=${dataSummary(item.data)}`;
}

/**
 * Returns a safe, human-readable summary of message changes, including exact
 * public program/account addresses and instruction payload bytes. The caller
 * must only display this after the wallet returns a message that failed the
 * immutable-message comparison; it is diagnostic, never an authorization.
 */
export function describeTransactionMessageChanges(original: Message, returned: Message): string[] {
  const before = original as unknown as MessageShape;
  const after = returned as unknown as MessageShape;
  const changes: string[] = [];

  if (before.version !== after.version)
    changes.push(
      `transaction message version changed (${String(before.version)} → ${String(after.version)})`,
    );
  if (before.recentBlockhash !== after.recentBlockhash)
    changes.push(
      `recent blockhash changed (${before.recentBlockhash ?? "missing"} → ${after.recentBlockhash ?? "missing"})`,
    );
  if (stable(before.header) !== stable(after.header))
    changes.push(
      `signer/header configuration changed (${stable(before.header)} → ${stable(after.header)})`,
    );

  const beforeKeys = keys(before);
  const afterKeys = keys(after);
  if (stable(beforeKeys) !== stable(afterKeys)) {
    const changedIndexes: number[] = [];
    for (let index = 0; index < Math.max(beforeKeys.length, afterKeys.length); index += 1) {
      if (beforeKeys[index] !== afterKeys[index]) changedIndexes.push(index);
    }
    changes.push(
      `account key list changed (${beforeKeys.length} → ${afterKeys.length}); changed indexes: ${changedIndexes.map((index) => `${index}: ${beforeKeys[index] ?? "<missing>"} → ${afterKeys[index] ?? "<missing>"}`).join(" | ")}`,
    );
  }

  const beforeInstructions = instructions(before);
  const afterInstructions = instructions(after);
  if (beforeInstructions.length !== afterInstructions.length) {
    changes.push(
      `instruction count changed (${beforeInstructions.length} → ${afterInstructions.length})`,
    );
  }
  for (
    let index = 0;
    index < Math.max(beforeInstructions.length, afterInstructions.length);
    index += 1
  ) {
    const left = beforeInstructions[index];
    const right = afterInstructions[index];
    if (!left) {
      changes.push(`wallet-added ${instructionSummary(right!, after, afterKeys, index)}`);
      continue;
    }
    if (!right) {
      changes.push(`wallet-removed ${instructionSummary(left, before, beforeKeys, index)}`);
      continue;
    }
    const beforeResolvedAccounts = left.accountKeyIndexes.map(
      (keyIndex) => beforeKeys[keyIndex] ?? `missing:${keyIndex}`,
    );
    const afterResolvedAccounts = right.accountKeyIndexes.map(
      (keyIndex) => afterKeys[keyIndex] ?? `missing:${keyIndex}`,
    );
    if (
      left.programIdIndex !== right.programIdIndex ||
      beforeKeys[left.programIdIndex] !== afterKeys[right.programIdIndex] ||
      stable(left.accountKeyIndexes) !== stable(right.accountKeyIndexes) ||
      stable(beforeResolvedAccounts) !== stable(afterResolvedAccounts)
    ) {
      changes.push(
        `instruction ${index + 1}: program/account references changed; before {${instructionSummary(left, before, beforeKeys, index)}}; after {${instructionSummary(right, after, afterKeys, index)}}`,
      );
    }
    if (stable(left.data) !== stable(right.data)) {
      changes.push(
        `instruction ${index + 1}: instruction data changed; before {${dataSummary(left.data)}}; after {${dataSummary(right.data)}}`,
      );
    }
  }

  const normalizeLookups = (items: MessageShape["addressTableLookups"]) =>
    (items ?? []).map((item) => ({
      accountKey: item.accountKey.toBase58(),
      writableIndexes: item.writableIndexes,
      readonlyIndexes: item.readonlyIndexes,
    }));
  if (
    stable(normalizeLookups(before.addressTableLookups)) !==
    stable(normalizeLookups(after.addressTableLookups))
  ) {
    changes.push(
      `address lookup table references changed (${stable(normalizeLookups(before.addressTableLookups))} → ${stable(normalizeLookups(after.addressTableLookups))})`,
    );
  }

  return changes;
}