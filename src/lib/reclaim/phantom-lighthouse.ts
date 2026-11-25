import bs58 from "bs58";
import {
  ComputeBudgetProgram,
  PublicKey,
  type Message,
} from "@solana/web3.js";

const LIGHTHOUSE_PROGRAM_ID = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
const MAX_PHANTOM_COMPUTE_UNIT_LIMIT = 1_400_000;

type Assertion =
  | { kind: "lamports"; value: bigint; operator: number }
  | { kind: "knownOwner"; value: number; operator: number }
  | { kind: "dataLength"; value: bigint; operator: number };

type ResolvedInstruction = {
  program: string;
  accounts: string[];
  data: Uint8Array;
};

function bytes(data: string): Uint8Array {
  return bs58.decode(data);
}

function resolveInstructions(message: Message): ResolvedInstruction[] {
  return message.instructions.map((instruction) => ({
    program: message.accountKeys[instruction.programIdIndex]?.toBase58() ?? "",
    accounts: instruction.accounts.map(
      (index) => message.accountKeys[index]?.toBase58() ?? `missing:${index}`,
    ),
    data: bytes(instruction.data),
  }));
}

function readU64(data: Uint8Array, offset: number): bigint | null {
  if (offset + 8 > data.length) return null;
  let value = BigInt(0);
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << BigInt(8)) | BigInt(data[offset + index]);
  }
  return value;
}

function parseAccountInfoAssertions(data: Uint8Array): Assertion[] | null {
  // Lighthouse AssertAccountInfoMulti: discriminator, log level, then a
  // LEB128-length-prefixed Borsh vector of AccountInfoAssertion values.
  if (data.length < 3 || data[0] !== 6 || data[1] !== 4) return null;
  let cursor = 2;
  let count = 0;
  let shift = 0;
  while (cursor < data.length && shift <= 28) {
    const byte = data[cursor++];
    count |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  if (count < 1 || count > 8) return null;

  const assertions: Assertion[] = [];
  for (let index = 0; index < count; index += 1) {
    if (cursor >= data.length) return null;
    const variant = data[cursor++];
    if (variant === 0 || variant === 1) {
      const value = readU64(data, cursor);
      if (value === null || cursor + 9 > data.length) return null;
      cursor += 8;
      const operator = data[cursor++];
      assertions.push(
        variant === 0
          ? { kind: "lamports", value, operator }
          : { kind: "dataLength", value, operator },
      );
    } else if (variant === 3) {
      if (cursor + 2 > data.length) return null;
      assertions.push({ kind: "knownOwner", value: data[cursor++], operator: data[cursor++] });
    } else {
      // Reject every assertion type outside the exact allowlisted shape.
      return null;
    }
  }

  return cursor === data.length ? assertions : null;
}

function isWalletPostcondition(instruction: ResolvedInstruction, wallet: string): boolean {
  if (
    instruction.program !== LIGHTHOUSE_PROGRAM_ID ||
    instruction.accounts.length !== 1 ||
    instruction.accounts[0] !== wallet
  ) return false;
  const assertions = parseAccountInfoAssertions(instruction.data);
  if (!assertions || assertions.length !== 3) return false;
  const [lamports, owner, dataLength] = assertions;
  return lamports?.kind === "lamports" && lamports.operator === 4 && lamports.value > BigInt(0) &&
    owner?.kind === "knownOwner" && owner.value === 0 && owner.operator === 0 &&
    dataLength?.kind === "dataLength" && dataLength.value === BigInt(0) && dataLength.operator === 0;
}

function isClosedAccountPostcondition(instruction: ResolvedInstruction, account: string): boolean {
  if (
    instruction.program !== LIGHTHOUSE_PROGRAM_ID ||
    instruction.accounts.length !== 1 ||
    instruction.accounts[0] !== account
  ) return false;
  const assertions = parseAccountInfoAssertions(instruction.data);
  if (!assertions || assertions.length !== 2) return false;
  const [owner, dataLength] = assertions;
  return owner?.kind === "knownOwner" && owner.value === 0 && owner.operator === 0 &&
    dataLength?.kind === "dataLength" && dataLength.value === BigInt(0) && dataLength.operator === 0;
}

function computeBudgetKind(instruction: ResolvedInstruction):
  | { kind: "limit"; units: number }
  | { kind: "price"; microLamports: bigint }
  | null {
  if (instruction.program !== ComputeBudgetProgram.programId.toBase58() || instruction.accounts.length !== 0) return null;
  const data = instruction.data;
  if (data.length === 5 && data[0] === 2) {
    const units = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, true);
    return { kind: "limit", units };
  }
  if (data.length === 9 && data[0] === 3) {
    const microLamports = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(1, true);
    return { kind: "price", microLamports };
  }
  return null;
}

function sameInstruction(left: ResolvedInstruction, right: ResolvedInstruction): boolean {
  return left.program === right.program &&
    JSON.stringify(left.accounts) === JSON.stringify(right.accounts) &&
    left.data.length === right.data.length &&
    left.data.every((byte, index) => byte === right.data[index]);
}

function accountRole(message: Message, index: number): string {
  const header = message.header;
  if (index < header.numRequiredSignatures) {
    return index < header.numRequiredSignatures - header.numReadonlySignedAccounts
      ? "signer+writable"
      : "signer+readonly";
  }
  return index < message.accountKeys.length - header.numReadonlyUnsignedAccounts
    ? "writable"
    : "readonly";
}

/**
 * Accepts only Phantom's documented Lighthouse post-state assertions for the
 * exact wallet and token accounts being closed, plus a bounded CU-limit uplift.
 * All business instructions, transfers, signer identity, account privileges,
 * blockhash and zero-priority-fee setting remain unchanged.
 */
export function validatePhantomLighthouseTransaction(
  original: Message,
  returned: Message,
  walletAddress: string,
  closedAccountAddresses: string[],
): { ok: true; walletMinimumLamports: bigint; computeUnitLimit: number } | { ok: false; reason: string } {
  const wallet = new PublicKey(walletAddress).toBase58();
  const closedAccounts = closedAccountAddresses.map((address) => new PublicKey(address).toBase58());
  if (new Set(closedAccounts).size !== closedAccounts.length || closedAccounts.includes(wallet)) {
    return { ok: false, reason: "Closed-account assertion targets are duplicated or overlap the fee payer." };
  }
  if (original.recentBlockhash !== returned.recentBlockhash) return { ok: false, reason: "Recent blockhash changed." };
  if (returned.header.numRequiredSignatures !== 1 || returned.header.numReadonlySignedAccounts !== original.header.numReadonlySignedAccounts) {
    return { ok: false, reason: "Unexpected signer/header configuration." };
  }
  if (original.header.numRequiredSignatures !== 1 || original.accountKeys[0]?.toBase58() !== wallet || returned.accountKeys[0]?.toBase58() !== wallet ||
    returned.header.numReadonlyUnsignedAccounts !== original.header.numReadonlyUnsignedAccounts + 1) {
    return { ok: false, reason: "Fee payer or signer identity changed." };
  }

  const originalKeys = original.accountKeys.map((key) => key.toBase58());
  const returnedKeys = returned.accountKeys.map((key) => key.toBase58());
  const expectedKeys = new Set([...originalKeys, LIGHTHOUSE_PROGRAM_ID]);
  if (returnedKeys.length !== expectedKeys.size || returnedKeys.some((key) => !expectedKeys.has(key)) || new Set(returnedKeys).size !== returnedKeys.length) {
    return { ok: false, reason: "Unexpected account key added, removed, or duplicated." };
  }
  for (const key of originalKeys) {
    const beforeIndex = originalKeys.indexOf(key);
    const afterIndex = returnedKeys.indexOf(key);
    if (afterIndex < 0 || accountRole(original, beforeIndex) !== accountRole(returned, afterIndex)) {
      return { ok: false, reason: `Account privilege changed for ${key}.` };
    }
  }
  const lighthouseIndex = returnedKeys.indexOf(LIGHTHOUSE_PROGRAM_ID);
  if (lighthouseIndex < 0 || accountRole(returned, lighthouseIndex) !== "readonly") {
    return { ok: false, reason: "Lighthouse program account is not readonly." };
  }

  const before = resolveInstructions(original);
  const after = resolveInstructions(returned);
  const beforeBudget = before.map(computeBudgetKind);
  const afterBudget = after.map(computeBudgetKind);
  const beforeBudgets = beforeBudget.filter((item): item is NonNullable<typeof item> => item !== null);
  const afterBudgets = afterBudget.filter((item): item is NonNullable<typeof item> => item !== null);
  if (beforeBudgets.length !== 2 || afterBudgets.length !== 2) return { ok: false, reason: "Expected exactly two Compute Budget instructions." };
  const beforeLimit = beforeBudgets.find((item) => item.kind === "limit");
  const beforePrice = beforeBudgets.find((item) => item.kind === "price");
  const afterLimit = afterBudgets.find((item) => item.kind === "limit");
  const afterPrice = afterBudgets.find((item) => item.kind === "price");
  if (!beforeLimit || !beforePrice || !afterLimit || !afterPrice || beforePrice.microLamports !== afterPrice.microLamports ||
    afterPrice.microLamports !== BigInt(0) || afterLimit.units < beforeLimit.units || afterLimit.units > MAX_PHANTOM_COMPUTE_UNIT_LIMIT) {
    return { ok: false, reason: "Compute Budget changes exceed the Phantom safety allowlist." };
  }
  if (before.some((item, index) => beforeBudget[index] === null && item.program === LIGHTHOUSE_PROGRAM_ID)) {
    return { ok: false, reason: "Original transaction unexpectedly contains Lighthouse instructions." };
  }

  const beforeBusiness = before.filter((item) => computeBudgetKind(item) === null);
  const afterBusiness = after.filter((item) => computeBudgetKind(item) === null && item.program !== LIGHTHOUSE_PROGRAM_ID);
  const lighthouse = after.filter((item) => item.program === LIGHTHOUSE_PROGRAM_ID);
  if (beforeBusiness.length !== afterBusiness.length || beforeBusiness.some((item, index) => !sameInstruction(item, afterBusiness[index]))) {
    return { ok: false, reason: "A non-budget application instruction was changed, removed, reordered, or added." };
  }
  if (lighthouse.length !== closedAccountAddresses.length + 1) {
    return { ok: false, reason: "Unexpected number of Lighthouse assertions." };
  }
  const firstBusinessIndex = after.findIndex((item) => computeBudgetKind(item) === null && item.program !== LIGHTHOUSE_PROGRAM_ID);
  const firstLighthouseIndex = after.findIndex((item) => item.program === LIGHTHOUSE_PROGRAM_ID);
  if (after.some((item, index) => computeBudgetKind(item) !== null && firstBusinessIndex >= 0 && index > firstBusinessIndex) ||
    after.some((item, index) => item.program !== LIGHTHOUSE_PROGRAM_ID && index > firstLighthouseIndex)) {
    return { ok: false, reason: "Compute Budget or Lighthouse instructions are not in the approved transaction positions." };
  }
  // Phantom may order Lighthouse assertions independently of the original
  // close-instruction order. Bind each assertion to its explicit account key;
  // never infer its meaning from its position in the instruction list.
  const walletAssertionsByTarget = lighthouse.filter(
    (instruction) => instruction.accounts.length === 1 && instruction.accounts[0] === wallet,
  );
  if (walletAssertionsByTarget.length !== 1 || !isWalletPostcondition(walletAssertionsByTarget[0], wallet)) {
    return { ok: false, reason: "Wallet Lighthouse assertion does not match the approved post-state checks." };
  }
  for (const account of closedAccounts) {
    const assertionsForAccount = lighthouse.filter(
      (instruction) => instruction.accounts.length === 1 && instruction.accounts[0] === account,
    );
    if (assertionsForAccount.length !== 1 || !isClosedAccountPostcondition(assertionsForAccount[0], account)) {
      return { ok: false, reason: `Lighthouse close assertion does not match token account ${account}.` };
    }
  }

  const walletAssertions = parseAccountInfoAssertions(walletAssertionsByTarget[0].data);
  const walletLamportsAssertion = walletAssertions?.[0];
  if (walletLamportsAssertion?.kind !== "lamports") return { ok: false, reason: "Wallet minimum-balance assertion could not be decoded." };
  return { ok: true, walletMinimumLamports: walletLamportsAssertion.value, computeUnitLimit: afterLimit.units };
}