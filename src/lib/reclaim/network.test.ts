// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  assertConnectionNetwork,
  getSolanaNetworkConfig,
  SOLANA_GENESIS_HASHES,
} from "./network";

describe("Solana network configuration", () => {
  it("requires an explicit supported network", () => {
    expect(() => getSolanaNetworkConfig({})).toThrow(/must be explicitly set/i);
    expect(() => getSolanaNetworkConfig({ NEXT_PUBLIC_SOLANA_NETWORK: "testnet" })).toThrow(/must be explicitly set/i);
  });

  it("uses the selected cluster default endpoint", () => {
    expect(getSolanaNetworkConfig({ NEXT_PUBLIC_SOLANA_NETWORK: "devnet" })).toMatchObject({
      network: "devnet",
      endpoint: "https://api.devnet.solana.com",
      explorerCluster: "devnet",
    });
    expect(getSolanaNetworkConfig({
      NEXT_PUBLIC_SOLANA_NETWORK: "mainnet-beta",
      NEXT_PUBLIC_APP_URL: "https://reclaimsol.example",
    })).toMatchObject({
      network: "mainnet-beta",
      endpoint: "https://reclaimsol.example/api/solana/rpc",
      explorerCluster: "mainnet-beta",
    });
  });

  it("requires HTTPS for non-local custom RPC endpoints", () => {
    expect(() => getSolanaNetworkConfig({
      NEXT_PUBLIC_SOLANA_NETWORK: "devnet",
      NEXT_PUBLIC_SOLANA_RPC_URL: "http://rpc.example.com",
    })).toThrow(/HTTPS/i);
    expect(getSolanaNetworkConfig({
      NEXT_PUBLIC_SOLANA_NETWORK: "devnet",
      NEXT_PUBLIC_SOLANA_RPC_URL: "http://localhost:8899",
    }).endpoint).toBe("http://localhost:8899");
  });

  it("checks the RPC genesis hash against the selected network", async () => {
    const currentDevnet = { getGenesisHash: vi.fn().mockResolvedValue(SOLANA_GENESIS_HASHES.devnet[0]) };
    const documentedDevnet = { getGenesisHash: vi.fn().mockResolvedValue(SOLANA_GENESIS_HASHES.devnet[1]) };
    const mainnet = { getGenesisHash: vi.fn().mockResolvedValue(SOLANA_GENESIS_HASHES["mainnet-beta"][0]) };

    await expect(assertConnectionNetwork(currentDevnet as never, "devnet")).resolves.toBeUndefined();
    await expect(assertConnectionNetwork(documentedDevnet as never, "devnet")).resolves.toBeUndefined();
    await expect(assertConnectionNetwork(mainnet as never, "mainnet-beta")).resolves.toBeUndefined();
    await expect(assertConnectionNetwork(currentDevnet as never, "mainnet-beta")).rejects.toThrow(/network mismatch/i);
  });
});

describe("Mainnet RPC routing", () => {
  it("pins Mainnet to the same-origin server proxy", () => {
    expect(getSolanaNetworkConfig({
      NEXT_PUBLIC_SOLANA_NETWORK: "mainnet-beta",
      NEXT_PUBLIC_APP_URL: "https://reclaimsol.example",
    })).toMatchObject({
      network: "mainnet-beta",
      endpoint: "https://reclaimsol.example/api/solana/rpc",
      explorerCluster: "mainnet-beta",
    });
  });

  it("requires the application origin for Mainnet proxy routing", () => {
    expect(() => getSolanaNetworkConfig({ NEXT_PUBLIC_SOLANA_NETWORK: "mainnet-beta" }))
      .toThrow(/NEXT_PUBLIC_APP_URL/i);
  });
});