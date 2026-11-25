// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getHeliusEndpoints, shouldFailOver, validateMainnetRpcPayload } from "./helius-rpc";

describe("Helius server-side RPC configuration", () => {
  it("returns primary then fallback endpoint without duplicates", () => {
    expect(getHeliusEndpoints({
      HELIUS_MAINNET_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=one",
      HELIUS_MAINNET_RPC_FALLBACK_URL: "https://mainnet.helius-rpc.com/?api-key=two",
    })).toEqual([
      "https://mainnet.helius-rpc.com/?api-key=one",
      "https://mainnet.helius-rpc.com/?api-key=two",
    ]);
  });
  it("rejects insecure or malformed endpoints", () => {
    expect(() => getHeliusEndpoints({ HELIUS_MAINNET_RPC_URL: "http://rpc.example" })).toThrow(/HTTPS/);
    expect(() => getHeliusEndpoints({ HELIUS_MAINNET_RPC_URL: "not a URL" })).toThrow(/invalid URL/i);
  });
});

describe("Mainnet JSON-RPC allowlist", () => {
  it("allows normal Solana read methods and bounded batches", () => {
    expect(validateMainnetRpcPayload({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" })).toBeNull();
    expect(validateMainnetRpcPayload([
      { jsonrpc: "2.0", id: 1, method: "getBalance", params: [] },
      { jsonrpc: "2.0", id: 2, method: "getTokenAccountsByOwner", params: [] },
    ])).toBeNull();
  });
  it("allows wallet-signed transaction submission but blocks unapproved methods and malformed batches", () => {
    expect(validateMainnetRpcPayload({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: ["signed-transaction"] })).toBeNull();
    expect(validateMainnetRpcPayload({ jsonrpc: "2.0", id: 1, method: "requestAirdrop" })).toMatch(/not enabled/i);
    expect(validateMainnetRpcPayload([])).toMatch(/batch size/i);
    expect(validateMainnetRpcPayload(Array.from({ length: 26 }, () => ({ jsonrpc: "2.0", id: 1, method: "getSlot" })))).toMatch(/batch size/i);
  });
});

describe("RPC failover decision", () => {
  it("fails over only on transient upstream server failures, never on quota/auth limits", () => {
    expect(shouldFailOver(429)).toBe(false);
    expect(shouldFailOver(401)).toBe(false);
    expect(shouldFailOver(403)).toBe(false);
    expect(shouldFailOver(503)).toBe(true);
    expect(shouldFailOver(200)).toBe(false);
  });
});