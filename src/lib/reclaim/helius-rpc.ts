/** Server-only Helius RPC proxy helpers. Never import this module into client components. */
export const ALLOWED_MAINNET_RPC_METHODS = new Set([
  "getAccountInfo", "getBalance", "getBlock", "getBlockHeight", "getBlockTime",
  "getEpochInfo", "getFeeForMessage", "getGenesisHash", "getLatestBlockhash", "getMinimumBalanceForRentExemption",
  "getMultipleAccounts", "getProgramAccounts", "getRecentPrioritizationFees", "getSignatureStatuses",
  "getSlot", "getSlotLeader", "getTokenAccountsByOwner", "getTokenAccountsByDelegate",
  "getTokenLargestAccounts", "getTokenSupply", "getTransaction", "getVersion",
  "isBlockhashValid", "simulateTransaction", "sendTransaction",
]);

export function getHeliusEndpoints(env: { HELIUS_MAINNET_RPC_URL?: string; HELIUS_MAINNET_RPC_FALLBACK_URL?: string } = process.env as { HELIUS_MAINNET_RPC_URL?: string; HELIUS_MAINNET_RPC_FALLBACK_URL?: string }): string[] {
  const values = [env.HELIUS_MAINNET_RPC_URL, env.HELIUS_MAINNET_RPC_FALLBACK_URL]
    .map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  for (const value of values) {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error("Helius RPC endpoint configuration contains an invalid URL."); }
    if (parsed.protocol !== "https:" || parsed.hostname !== "mainnet.helius-rpc.com") {
      throw new Error("Mainnet RPC endpoints must use the official Helius Mainnet RPC hostname over HTTPS.");
    }
  }
  return [...new Set(values)];
}

export function validateMainnetRpcPayload(payload: unknown): string | null {
  const calls = Array.isArray(payload) ? payload : [payload];
  if (calls.length === 0 || calls.length > 25) return "Invalid JSON-RPC batch size.";
  for (const call of calls) {
    if (!call || typeof call !== "object") return "Invalid JSON-RPC request.";
    const candidate = call as { jsonrpc?: unknown; method?: unknown };
    if (candidate.jsonrpc !== "2.0" || typeof candidate.method !== "string") return "Invalid JSON-RPC request.";
    if (!ALLOWED_MAINNET_RPC_METHODS.has(candidate.method)) return `RPC method is not enabled by the Mainnet proxy: ${candidate.method}`;
  }
  return null;
}

export function shouldFailOver(status: number): boolean {
  // Never route around provider quota/auth limits by consuming the other account.
  // Fail over only for transient upstream server failures or transport failures.
  return status >= 500 && status !== 429;
}