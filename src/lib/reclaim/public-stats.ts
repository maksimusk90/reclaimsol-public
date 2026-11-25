const TREASURY = "4fnyv4J1UqBNQRAYjtAFYFuTyMd63z48xhp1iDZ5TaCM";
const SERVICE_FEE_BPS = 1500;

type ParsedInstruction = {
  program?: string;
  programId?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
};
export type ParsedTransaction = {
  transaction: { message: { accountKeys: Array<string | { pubkey: string; signer?: boolean }>; instructions?: ParsedInstruction[] } };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
    innerInstructions?: Array<{ instructions: ParsedInstruction[] }> | null;
  };
};
function keyString(key: string | { pubkey: string }) {
  return typeof key === "string" ? key : key.pubkey;
}

export function reconcilePublicRecovery(transaction: ParsedTransaction | null) {
  if (!transaction?.meta || transaction.meta.err !== null || transaction.meta.loadedAddresses?.writable.length || transaction.meta.loadedAddresses?.readonly.length) return null;
  const { accountKeys } = transaction.transaction.message;
  const keys = accountKeys.map(keyString);
  const pre = transaction.meta.preBalances;
  const post = transaction.meta.postBalances;
  if (!keys.length || pre.length !== keys.length || post.length !== keys.length || !Number.isSafeInteger(transaction.meta.fee) || transaction.meta.fee < 0) return null;

  const treasuryIndex = keys.indexOf(TREASURY);
  if (treasuryIndex < 0 || !Number.isSafeInteger(pre[treasuryIndex]) || !Number.isSafeInteger(post[treasuryIndex])) return null;
  const treasuryDelta = BigInt(post[treasuryIndex]) - BigInt(pre[treasuryIndex]);
  if (treasuryDelta <= BigInt(0)) return null;

  const instructions = [
    ...(transaction.transaction.message.instructions ?? []),
    ...(transaction.meta.innerInstructions ?? []).flatMap((group) => group.instructions),
  ];

  const transfers = instructions.filter((instruction) =>
    instruction.program === "system" &&
    instruction.parsed?.type === "transfer" &&
    instruction.parsed.info?.destination === TREASURY
  );
  if (transfers.length !== 1) return null;
  const transferInfo = transfers[0].parsed?.info;
  const transferLamports = transferInfo?.lamports;
  const wallet = transferInfo?.source;
  if (typeof wallet !== "string" || typeof transferLamports !== "number" || !Number.isSafeInteger(transferLamports) || BigInt(transferLamports) !== treasuryDelta) return null;

  const walletIndex = keys.indexOf(wallet);
  if (walletIndex !== 0 || !Number.isSafeInteger(pre[walletIndex]) || !Number.isSafeInteger(post[walletIndex])) return null;
  const closeInstructions = instructions.filter((instruction) =>
    (instruction.program === "spl-token" || instruction.program === "spl-token-2022") &&
    instruction.parsed?.type === "closeAccount" &&
    instruction.parsed.info?.destination === wallet &&
    instruction.parsed.info?.owner === wallet &&
    typeof instruction.parsed.info?.account === "string"
  );
  if (!closeInstructions.length) return null;

  const closedAccounts = new Set<string>();
  let gross = BigInt(0);
  for (const instruction of closeInstructions) {
    const address = instruction.parsed?.info?.account as string;
    if (closedAccounts.has(address)) return null;
    closedAccounts.add(address);
    const index = keys.indexOf(address);
    if (index < 0 || !Number.isSafeInteger(pre[index]) || !Number.isSafeInteger(post[index]) || pre[index] <= 0 || post[index] !== 0) return null;
    gross += BigInt(pre[index]);
  }

  const expectedFee = (gross * BigInt(SERVICE_FEE_BPS)) / BigInt(10000);
  if (expectedFee !== treasuryDelta) return null;
  const walletDelta = BigInt(post[walletIndex]) - BigInt(pre[walletIndex]);
  const expectedWalletDelta = gross - treasuryDelta - BigInt(transaction.meta.fee);
  if (walletDelta !== expectedWalletDelta) return null;

  return { grossLamports: gross, closedAccounts: closedAccounts.size };
}
