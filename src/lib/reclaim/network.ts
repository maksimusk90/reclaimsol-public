import type { Connection } from "@solana/web3.js";

export type SolanaNetwork = "devnet" | "mainnet-beta";

export const SOLANA_DEFAULT_RPC_ENDPOINTS: Record<SolanaNetwork, string> = {
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet.solana.com",
};

// The live public endpoint and the official RPC example currently show different
// Devnet hashes. Accept only those two known Devnet values; all others fail closed.
export const SOLANA_GENESIS_HASHES: Record<SolanaNetwork, readonly string[]> = {
  devnet: [
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    "GH7ome3EiwEr7tu9JuTh2dpYWBJK3z69Xm1ZE3MEE6JC",
  ],
  "mainnet-beta": ["5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"],
};

export type SolanaNetworkEnvironment = {
  NEXT_PUBLIC_SOLANA_NETWORK?: string;
  NEXT_PUBLIC_SOLANA_RPC_URL?: string;
  NEXT_PUBLIC_APP_URL?: string;
};

/**
 * A network must be selected explicitly. A custom RPC URL is accepted only
 * after its genesis hash is checked against the selected cluster at runtime.
 */
export function getSolanaNetworkConfig(
  env?: SolanaNetworkEnvironment,
): { network: SolanaNetwork; endpoint: string; explorerCluster: SolanaNetwork } {
  // Keep direct process.env references so Next.js can inline public build variables.
  const network = env
    ? env.NEXT_PUBLIC_SOLANA_NETWORK
    : process.env.NEXT_PUBLIC_SOLANA_NETWORK;

  if (network !== "devnet" && network !== "mainnet-beta") {
    throw new Error(
      "NEXT_PUBLIC_SOLANA_NETWORK must be explicitly set to devnet or mainnet-beta.",
    );
  }

  // Mainnet RPC credentials must never enter the browser bundle. Mainnet is
  // therefore pinned to the same-origin, server-side read-only Helius proxy.
  const configuredRpcUrl = env
    ? env.NEXT_PUBLIC_SOLANA_RPC_URL
    : process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
  const appUrl = env
    ? env.NEXT_PUBLIC_APP_URL
    : process.env.NEXT_PUBLIC_APP_URL;
  let endpoint: string;
  if (network === "mainnet-beta") {
    if (!appUrl?.trim()) {
      throw new Error("NEXT_PUBLIC_APP_URL must be set to the current application origin for Mainnet RPC proxy routing.");
    }
    try {
      endpoint = new URL("/api/solana/rpc", appUrl).toString();
    } catch {
      throw new Error("NEXT_PUBLIC_APP_URL must be a valid absolute URL for Mainnet RPC proxy routing.");
    }
  } else {
    endpoint = configuredRpcUrl?.trim() || SOLANA_DEFAULT_RPC_ENDPOINTS[network];
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint, "https://reclaimsol.invalid");
  } catch {
    throw new Error("NEXT_PUBLIC_SOLANA_RPC_URL must be a valid absolute URL.");
  }

  const localHost =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1";

  if (parsed.protocol !== "https:" && !(localHost && parsed.protocol === "http:")) {
    throw new Error("Solana RPC must use HTTPS, except for a local development endpoint.");
  }

  return { network, endpoint, explorerCluster: network };
}

/**
 * Verify the actual RPC cluster, not merely its URL or environment label.
 */
export async function assertConnectionNetwork(
  connection: Pick<Connection, "getGenesisHash">,
  network: SolanaNetwork,
): Promise<void> {
  const actualGenesisHash = await connection.getGenesisHash();
  const expectedGenesisHashes = SOLANA_GENESIS_HASHES[network];

  if (!expectedGenesisHashes.includes(actualGenesisHash)) {
    throw new Error(
      `Solana RPC network mismatch. The app is configured for ${network}, but the connected RPC reports a different genesis hash. No scan or transaction may continue.`,
    );
  }
}