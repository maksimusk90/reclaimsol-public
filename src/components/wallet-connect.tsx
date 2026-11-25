"use client";

import { useEffect, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { formatWalletAddress } from "@/lib/format-wallet-address";

export function WalletConnect() {
  const {
    wallet,
    connected,
    connecting,
    publicKey,
    connect,
    disconnect,
  } = useWallet();

  const { connection } = useConnection();
  const { setVisible } = useWalletModal();

  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [balanceLamports, setBalanceLamports] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [balanceRefresh, setBalanceRefresh] = useState(0);

  const address = publicKey?.toBase58() ?? null;

  // Fetch wallet balance from Solana Devnet
  useEffect(() => {
    let cancelled = false;

    if (!connected || !publicKey) {
      return;
    }

    async function fetchBalance() {
      setBalanceLamports(null);
      setBalanceLoading(true);
      setBalanceError(null);

      try {
        const balance = await connection.getBalance(
          publicKey!,
          "confirmed"
        );

        if (!cancelled) {
          setBalanceLamports(balance);
        }
      } catch (error) {
        if (!cancelled) {
          console.error("[ReclaimSOL] Balance fetch failed:", error);

          setBalanceError(
            error instanceof Error
              ? error.message
              : String(error)
          );
        }
      } finally {
        if (!cancelled) {
          setBalanceLoading(false);
        }
      }
    }

    void fetchBalance();

    return () => {
      cancelled = true;
    };
  }, [connected, publicKey, connection, balanceRefresh]);

  useEffect(() => {
    function handleAdapterError(event: Event) {
      const customEvent = event as CustomEvent<{ message?: string }>;
      setConnectionError(
        customEvent.detail?.message ||
          "Wallet connection failed. Please try again."
      );
    }

    window.addEventListener("reclaimsol:wallet-error", handleAdapterError);
    return () => {
      window.removeEventListener("reclaimsol:wallet-error", handleAdapterError);
    };
  }, []);

  async function handleConnect() {
    setConnectionError(null);

    if (!wallet) {
      console.log("[ReclaimSOL] Opening wallet modal");
      setVisible(true);
      return;
    }

    console.log(
      "[ReclaimSOL] Connecting to:",
      wallet.adapter.name
    );

    try {
      await connect();
      console.log("[ReclaimSOL] Connection successful");
    } catch (error) {
      console.error("[ReclaimSOL] Connect failed:", error);

      setConnectionError(
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error)
      );
    }
  }

  async function handleDisconnect() {
    setConnectionError(null);

    try {
      await disconnect();
      console.log("[ReclaimSOL] Disconnected");
    } catch (error) {
      console.error("[ReclaimSOL] Disconnect failed:", error);

      setConnectionError(
        error instanceof Error
          ? error.message
          : String(error)
      );
    }
  }

  const formattedBalance =
    balanceLamports !== null
      ? (balanceLamports / LAMPORTS_PER_SOL).toLocaleString(
          "en-US",
          {
            minimumFractionDigits: 0,
            maximumFractionDigits: 9,
          }
        )
      : null;

  return (
    <div>
      {connected && address ? (
        <div className="wallet-control">
          <div className="wallet-address">
            <span className="wallet-indicator" />
            <span>{formatWalletAddress(address)}</span>
          </div>

          <button
            className="wallet-button wallet-button-secondary"
            onClick={() => void handleDisconnect()}
            type="button"
          >
            Disconnect
          </button>

          <div className="wallet-balance" aria-live="polite">
            <span>
              {balanceLoading
                ? "Loading…"
                : formattedBalance !== null
                  ? `${formattedBalance} SOL`
                  : "Balance unavailable"}
            </span>
            <button
              className="wallet-balance-refresh"
              type="button"
              onClick={() => setBalanceRefresh((value) => value + 1)}
              disabled={balanceLoading}
              aria-label="Refresh wallet balance"
              title="Refresh wallet balance"
            >
              {balanceLoading ? "…" : "↻"}
            </button>
          </div>
        </div>
      ) : (
        <button
          className="wallet-button"
          onClick={() => void handleConnect()}
          disabled={connecting}
          type="button"
        >
          {connecting
            ? "Connecting..."
            : wallet
              ? `Connect ${wallet.adapter.name}`
              : "Connect wallet"}
          <span aria-hidden="true">↗</span>
        </button>
      )}

      {connectionError && (
        <p role="alert" className="wallet-error">
          {connectionError}
        </p>
      )}

      {balanceError && (
        <p role="alert" className="wallet-error">
          Balance RPC error: {balanceError}
        </p>
      )}

    </div>
  );
}