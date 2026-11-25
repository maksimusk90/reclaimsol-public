"use client";

import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import type { Adapter, WalletError } from "@solana/wallet-adapter-base";
import type { ReactNode } from "react";
import { getSolanaNetworkConfig } from "@/lib/reclaim/network";

const { endpoint } = getSolanaNetworkConfig();

function handleWalletError(error: WalletError, adapter?: Adapter) {
  const details = {
    message: error.message,
    name: error.name,
    adapter: adapter?.name ?? "Unknown",
    stack: error.stack ?? null,
  };

  console.error("[ReclaimSOL Wallet Error]", details);

  window.dispatchEvent(
    new CustomEvent("reclaimsol:wallet-error", {
      detail: details,
    })
  );
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider
        wallets={[]}
        autoConnect={false}
        onError={handleWalletError}
      >
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}