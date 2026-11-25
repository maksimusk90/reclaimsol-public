"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ed25519 } from "@noble/curves/ed25519.js";
import { PublicKey, Transaction, VersionedTransaction, type Message } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getTokenMetadata, unpackMint } from "@solana/spl-token";
import { describeTransactionMessageChanges } from "@/lib/reclaim/message-integrity";
import { validatePhantomLighthouseTransaction } from "@/lib/reclaim/phantom-lighthouse";
import { toWalletLegacyTransaction } from "@/lib/reclaim/wallet-legacy-transaction";
import { normalizeWalletSignedTransaction } from "@/lib/reclaim/wallet-signed-result";
import { formatLamports, scanWallet } from "@/lib/reclaim/scanner";
import type { ScanResult, ScanRow } from "@/lib/reclaim/types";
import { planCloseAccountBatches, prepareCloseAccountBatch, refreshPreparedCloseBatchForSigning, validatePreparedCloseBatch } from "@/lib/reclaim/batch";
import type { PreparedCloseBatch } from "@/lib/reclaim/batch";
import { executeBatchLifecycle } from "@/lib/reclaim/batch-lifecycle";
import { validateBatchEconomics } from "@/lib/reclaim/economics";
import { assertConnectionNetwork, getSolanaNetworkConfig } from "@/lib/reclaim/network";
import { confirmTransactionWithStatusFallback, getSignedTransactionSignature, inspectTransactionOutcome } from "@/lib/reclaim/execution";
import { reconcileConfirmedTransaction } from "@/lib/reclaim/reconciliation";
import { createPendingTransaction, readPendingTransactions, removePendingTransactions, savePendingTransactions } from "@/lib/reclaim/pending";
import type { PendingTransaction } from "@/lib/reclaim/pending";
import { groupPendingTransactions, resolvePendingTransactionGroup } from "@/lib/reclaim/pending-recovery";

function subscribeToLocation(callback: () => void) {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
}

function getPhantomDiagnosticsFlag() {
  return new URLSearchParams(window.location.search).get("phantomSigningTest") === "1";
}

type ReconciledBatch = {
  signature: string;
  actualNetworkFeeLamports: bigint;
  actualGrossRentLamports: bigint;
  actualServiceFeeLamports: bigint;
  actualNetRecoveredLamports: bigint;
};

type State =
  | { status: "idle" }
  | { status: "planning" }
  | { status: "running"; total: number; current: number; confirmed: number }
  | { status: "review"; total: number; current: number; confirmed: number; accountCount: number; gross: bigint; serviceFee: bigint; serviceFeeBps: number; networkFee: bigint; net: bigint; feePayerBalance: bigint; treasuryAddress: string }
  | { status: "completed"; total: number; signatures: string[]; reconciliations: ReconciledBatch[] }
  | { status: "cancelled"; total: number; confirmed: number; cancelledIndex: number }
  | { status: "verifying"; total: number; confirmed: number; failedIndex: number; message: string; signature: string }
  | { status: "failed" | "unknown"; total: number; confirmed: number; failedIndex: number; message: string; signature?: string };

const short = (value: string) => value.length > 12 ? value.slice(0, 5) + "…" + value.slice(-5) : value;
const explorer = (signature: string, network: string) =>
  `https://explorer.solana.com/tx/${signature}?cluster=${network === "mainnet-beta" ? "mainnet-beta" : "devnet"}`;

type TokenDisplayMetadata = { name: string; symbol: string; image: string | null; decimals: number | null };

function readMetadataString(data: Uint8Array, offset: number): { value: string; next: number } {
  if (offset + 4 > data.length) throw new Error("Invalid token metadata");
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
  const start = offset + 4;
  const end = start + length;
  if (end > data.length) throw new Error("Invalid token metadata");
  return { value: new TextDecoder().decode(data.slice(start, end)).replace(/\x00/g, "").trim(), next: end };
}

function formatTokenAmount(raw: string, decimals: number): string {
  const value = BigInt(raw);
  if (decimals === 0) return value.toString();
  const scale = BigInt(10) ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? whole.toString() + "." + fraction : whole.toString();
}
function TokenAccountCard({ row, selected, disabled, onToggle }: {
  row: ScanRow; selected: boolean; disabled: boolean; onToggle: (checked: boolean) => void;
}) {
  const { connection } = useConnection();
  const [metadata, setMetadata] = useState<TokenDisplayMetadata | null>(null);
  useEffect(() => {
    let active = true;
    if (!row.mint) return () => { active = false; };
    const programId = row.program === "Token-2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const mint = new PublicKey(row.mint);
    const metadataProgram = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
    void (async () => {
      let decimals: number | null = null;
      let name = "";
      let symbol = "";
      let image: string | null = null;
      try {
        const mintInfo = await connection.getAccountInfo(mint, "confirmed");
        if (mintInfo && mintInfo.owner.equals(programId)) decimals = unpackMint(mint, mintInfo, programId).decimals;
      } catch { /* Metadata is optional; never block account selection. */ }
      if (row.program === "Token-2022") {
        try {
          const tokenMetadata = await getTokenMetadata(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
          if (tokenMetadata) {
            name = tokenMetadata.name.trim();
            symbol = tokenMetadata.symbol.trim();
            const uri = tokenMetadata.uri.trim();
            if (/^https:\/\//i.test(uri)) {
              const response = await fetch(uri, { signal: AbortSignal.timeout(4500) });
              if (response.ok) {
                const json = await response.json() as { image?: unknown };
                if (typeof json.image === "string" && /^https:\/\//i.test(json.image)) image = json.image;
              }
            }
          }
        } catch { /* Token-2022 metadata is optional; try Metaplex below as a fallback. */ }
      }
      if (!name || !symbol) {
        try {
          const [metadataAddress] = PublicKey.findProgramAddressSync(
            [new TextEncoder().encode("metadata"), metadataProgram.toBytes(), mint.toBytes()], metadataProgram,
          );
          const info = await connection.getAccountInfo(metadataAddress, "confirmed");
          if (info?.owner.equals(metadataProgram)) {
            const bytes = info.data;
            let offset = 65;
            const parsedName = readMetadataString(bytes, offset); name = name || parsedName.value; offset = parsedName.next;
            const parsedSymbol = readMetadataString(bytes, offset); symbol = symbol || parsedSymbol.value; offset = parsedSymbol.next;
            const parsedUri = readMetadataString(bytes, offset);
            if (!image && /^https:\/\//i.test(parsedUri.value)) {
              const response = await fetch(parsedUri.value, { signal: AbortSignal.timeout(4500) });
              if (response.ok) {
                const json = await response.json() as { image?: unknown };
                if (typeof json.image === "string" && /^https:\/\//i.test(json.image)) image = json.image;
              }
            }
          }
        } catch { /* Some tokens have no Metaplex metadata or use unavailable URIs. */ }
      }
      if (active) setMetadata({ name, symbol, image, decimals });
    })();
    return () => { active = false; };
  }, [connection, row.mint, row.program]);

  const amount = row.tokenAmount !== null && metadata?.decimals !== null && metadata?.decimals !== undefined
    ? formatTokenAmount(row.tokenAmount, metadata.decimals)
    : row.tokenAmount;
  const shortMint = row.mint ? short(row.mint) : "Unknown mint";
  return <article className={`scanner-row token-account-card${selected ? " token-account-card-selected" : ""}`}>
    <div className="token-card-identity">
      {metadata?.image ? <img className="token-card-image" src={metadata.image} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <div className="token-card-image token-card-image-fallback" aria-hidden="true">{(metadata?.symbol || metadata?.name || "T").slice(0, 1).toUpperCase()}</div>}
      <div className="scanner-row-main">
        <div className="token-card-title">{metadata?.name || "Token account"} <span>{metadata?.symbol ? `${metadata.symbol}` : ""}</span></div>
        <div className="scanner-account-meta">{row.program} · Mint <span title={row.mint ?? ""}>{shortMint}</span></div>
        <div className="scanner-account-meta">Account <span title={row.address}>{short(row.address)}</span></div>
        <div className="scanner-reason">{row.reason}</div>
      </div>
    </div>
    <div className="scanner-row-side token-card-side">
      {(row.status === "reclaimable" || row.reasonCode === "WITHHELD_TRANSFER_FEE" || row.status === "has_tokens") && <label className="scanner-status scanner-select-control"><input type="checkbox" checked={selected} onChange={(event) => onToggle(event.target.checked)} disabled={disabled} /> {row.status === "has_tokens" ? (BigInt(row.withheldAmount) > BigInt(0) ? "Burn + harvest + close" : "Burn + close") : row.reasonCode === "WITHHELD_TRANSFER_FEE" ? "Harvest + close" : "Select"}</label>}
      <span className={`scanner-status scanner-status-${row.status}`}>{label(row)}</span>
      {row.tokenAmount !== null && <div className="token-card-balance"><small>{row.status === "has_tokens" ? "Amount to be burned" : "Token balance"}</small><strong>{amount ?? row.tokenAmount} {metadata?.symbol || ""}</strong><small>{metadata?.decimals === null || metadata?.decimals === undefined ? "Raw base units; decimals unavailable" : `Full balance · ${metadata.decimals} decimals`}</small></div>}
      {BigInt(row.withheldAmount) > BigInt(0) && <small>Withheld fees (base units): {row.withheldAmount}</small>}
      <strong>{formatLamports(row.lamports)} SOL</strong><small>Recoverable account rent</small>
    </div>
  </article>;
}

function label(row: ScanRow): string {
  switch (row.status) {
    case "reclaimable": return "Eligible";
    case "has_tokens": return "Contains tokens";
    case "review_required": return "Review required";
    case "unsupported": return "Unsupported";
    case "scan_error": return "Scan error";
  }
}

export function WalletBatchScanner() {
  const { connection } = useConnection();
  const { connected, publicKey, signTransaction, wallet: selectedWallet } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const { network } = getSolanaNetworkConfig();
  const [result, setResult] = useState<ScanResult | null>(null);
  const [scannedWallet, setScannedWallet] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [harvestConsent, setHarvestConsent] = useState(false);
  const [burnConsent, setBurnConsent] = useState(false);
  const [state, setState] = useState<State>({ status: "idle" });
  const [pending, setPending] = useState<PendingTransaction[]>([]);
  const [pendingLoaded, setPendingLoaded] = useState(false);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [recheckingPending, setRecheckingPending] = useState(false);
  const [legacyRecoverySignature, setLegacyRecoverySignature] = useState<string | null>(null);
  const [legacyRecoveryError, setLegacyRecoveryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const diagnosticsEnabled = useSyncExternalStore(subscribeToLocation, getPhantomDiagnosticsFlag, () => false);
  const [signingMethod, setSigningMethod] = useState<"adapter" | "provider">("adapter");
  const signingMethodRef = useRef<"adapter" | "provider">("adapter");
  const running = useRef(false);
  const autoRecheckWallet = useRef<string | null>(null);
  const approvalResolver = useRef<((approved: boolean) => void) | null>(null);
  const walletStateRef = useRef({ wallet, connected });

  useEffect(() => {
    walletStateRef.current = { wallet, connected };
  }, [wallet, connected]);

  function changeSigningMethod(next: "adapter" | "provider") {
    signingMethodRef.current = next;
    setSigningMethod(next);
  }

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      try { setPending(readPendingTransactions(window.localStorage)); }
      catch (cause) { setPendingError(cause instanceof Error ? cause.message : "Pending transaction storage is unavailable."); }
      finally { setPendingLoaded(true); }
    });
    return () => { active = false; };
  }, []);

  const walletPending = useMemo(
    () => pending.filter((item) => item.network === network && item.walletAddress === wallet),
    [pending, network, wallet],
  );
  const eligible = useMemo(() => result && scannedWallet === wallet ? result.rows.filter((row) => row.status === "reclaimable") : [], [result, scannedWallet, wallet]);
  const withheldRows = useMemo(() => result && scannedWallet === wallet ? result.rows.filter((row) => row.reasonCode === "WITHHELD_TRANSFER_FEE") : [], [result, scannedWallet, wallet]);
  const tokenRows = useMemo(() => result && scannedWallet === wallet ? result.rows.filter((row) => row.status === "has_tokens") : [], [result, scannedWallet, wallet]);
  const selectable = useMemo(
    () => [...eligible, ...withheldRows, ...tokenRows].filter(
      (row) => !walletPending.some((item) => item.accountAddress === row.address),
    ),
    [eligible, withheldRows, tokenRows, walletPending],
  );
  const chosen = useMemo(() => selectable.filter((row) => selected.includes(row.address)), [selectable, selected]);
  const selectedWithheldCount = chosen.filter((row) => BigInt(row.withheldAmount) > BigInt(0)).length;
  const selectedBurnCount = chosen.filter((row) => row.tokenAmount !== null && BigInt(row.tokenAmount) > BigInt(0)).length;
  const gross = chosen.reduce((sum, row) => sum + row.lamports, BigInt(0));
  const bps = Number(process.env.NEXT_PUBLIC_RECLAIMSOL_SERVICE_FEE_BPS || "1500");
  const fee = gross * BigInt(Number.isSafeInteger(bps) ? bps : 1500) / BigInt(10000);
  const busy = state.status === "planning" || state.status === "running" || state.status === "review";

  const reconcilePendingGroup = useCallback(async (group: readonly PendingTransaction[]) => {
    const first = group[0];
    if (!first) throw new Error("Pending transaction group is empty.");

    const treasuryAddress = first.treasuryAddress || process.env.NEXT_PUBLIC_TREASURY_ADDRESS;
    const serviceFeeBps = first.serviceFeeBps ?? Number(process.env.NEXT_PUBLIC_RECLAIMSOL_SERVICE_FEE_BPS || "1500");
    if (!treasuryAddress || !Number.isSafeInteger(serviceFeeBps) || serviceFeeBps < 1 || serviceFeeBps >= 10_000) {
      throw new Error("Treasury or service fee configuration is unavailable for pending reconciliation.");
    }

    if (group.some((item) =>
      item.treasuryAddress !== first.treasuryAddress ||
      item.grossRentLamports !== first.grossRentLamports ||
      item.serviceFeeLamports !== first.serviceFeeLamports ||
      item.serviceFeeBps !== first.serviceFeeBps
    )) {
      throw new Error("Pending transaction group contains inconsistent reconciliation metadata.");
    }

    return reconcileConfirmedTransaction(connection, first.signature, {
      walletAddress: first.walletAddress,
      treasuryAddress,
      grossRentLamports: first.grossRentLamports === undefined ? undefined : BigInt(first.grossRentLamports),
      serviceFeeLamports: first.serviceFeeLamports === undefined ? undefined : BigInt(first.serviceFeeLamports),
      serviceFeeBps,
      accounts: group.map((item) => ({
        address: item.accountAddress,
        rentLamports: item.accountRentLamports === undefined ? undefined : BigInt(item.accountRentLamports),
      })),
    });
  }, [connection]);

  async function releaseLegacyPendingGroup(group: readonly PendingTransaction[]) {
    const first = group[0];
    if (!first || !wallet || first.walletAddress !== wallet || first.network !== network ||
      group.some((item) => item.blockhash || item.lastValidBlockHeight !== undefined) ||
      legacyRecoverySignature || running.current) return;

    setLegacyRecoveryError(null);
    setLegacyRecoverySignature(first.signature);
    try {
      const outcome = await inspectTransactionOutcome(connection, first.signature);
      if (outcome.status !== "unknown" || !outcome.reason.includes("not found in the RPC history")) {
        throw new Error("The signature is not confirmed absent from RPC history. The pending lock was not changed.");
      }

      for (const item of group) {
        const response = await connection.getParsedAccountInfo(new PublicKey(item.accountAddress), "confirmed");
        const account = response.value;
        if (!account || (!account.owner.equals(TOKEN_PROGRAM_ID) && !account.owner.equals(TOKEN_2022_PROGRAM_ID))) {
          throw new Error(`Account ${short(item.accountAddress)} is missing or is not owned by a supported token program. The lock remains.`);
        }
        const parsed = account.data as unknown as { program?: string; parsed?: { type?: string; info?: { owner?: string } } };
        if ((parsed.program !== "spl-token" && parsed.program !== "spl-token-2022") || parsed.parsed?.type !== "account" || parsed.parsed.info?.owner !== wallet) {
          throw new Error(`Account ${short(item.accountAddress)} could not be verified as a token account belonging to this wallet. The lock remains.`);
        }
      }

      const accepted = window.confirm(`Legacy pending recovery for ${group.length} account(s). RPC currently cannot find signature ${first.signature}, and every affected account still exists as a token account owned by this wallet. The old record has no saved blockhash, so ReclaimSOL cannot prove expiry automatically. Continue ONLY if you independently checked this exact signature in Solana Explorer and confirmed it is absent. This removes only the local pending lock; it does not send a transaction. Continue?`);
      if (!accepted) return;
      removePendingTransactions(window.localStorage, group);
      setPending(readPendingTransactions(window.localStorage));
    } catch (cause) {
      setLegacyRecoveryError(cause instanceof Error ? cause.message : "Legacy pending recovery could not be verified. The lock remains.");
    } finally {
      setLegacyRecoverySignature(null);
    }
  }
  const recheckPending = useCallback(async () => {
    if (!wallet || !pendingLoaded || pendingError || running.current) return;
    running.current = true;
    setRecheckingPending(true);
    const reconciledBatches: ReconciledBatch[] = [];
    try {
      const stored = readPendingTransactions(window.localStorage).filter(
        (item) => item.network === network && item.walletAddress === wallet,
      );
      for (const group of groupPendingTransactions(stored)) {
        await resolvePendingTransactionGroup(
          window.localStorage,
          group,
          (signature) => inspectTransactionOutcome(connection, signature),
          (address) => connection.getAccountInfo(new PublicKey(address), "confirmed"),
          async (items) => {
            const reconciled = await reconcilePendingGroup(items);
            const first = items[0];
            if (first) reconciledBatches.push({ signature: first.signature, ...reconciled });
            return reconciled;
          },
          async (items) => {
            const first = items[0];
            if (!first?.blockhash || first.lastValidBlockHeight === undefined ||
              items.some((item) => item.blockhash !== first.blockhash || item.lastValidBlockHeight !== first.lastValidBlockHeight)) return false;
            const currentBlockHeight = await connection.getBlockHeight("confirmed");
            if (currentBlockHeight <= first.lastValidBlockHeight) return false;
            for (const item of items) {
              // An expired transaction cannot land later. A missing account is already closed;
              // an existing account must still be a token account owned by this wallet.
              const response = await connection.getParsedAccountInfo(new PublicKey(item.accountAddress), "confirmed");
              const account = response.value;
              if (account === null) continue;
              if (!account.owner.equals(TOKEN_PROGRAM_ID) && !account.owner.equals(TOKEN_2022_PROGRAM_ID)) return false;
              const parsed = account.data as unknown as { program?: string; parsed?: { type?: string; info?: { owner?: string } } };
              if ((parsed.program !== "spl-token" && parsed.program !== "spl-token-2022") ||
                parsed.parsed?.type !== "account" || parsed.parsed.info?.owner !== wallet) return false;
            }
            return true;
          },
        );
      }
      setPending(readPendingTransactions(window.localStorage));
      if (reconciledBatches.length > 0) {
        setState((current) => current.status === "verifying"
          ? {
              status: "completed",
              total: reconciledBatches.length,
              signatures: reconciledBatches.map((item) => item.signature),
              reconciliations: reconciledBatches,
            }
          : current);
      }
    } catch (cause) {
      setPendingError(cause instanceof Error ? cause.message : "Pending transaction verification is unavailable.");
    } finally {
      running.current = false;
      setRecheckingPending(false);
    }
  }, [wallet, pendingLoaded, pendingError, network, connection, reconcilePendingGroup]);

  useEffect(() => {
    if (!connected || !wallet) {
      autoRecheckWallet.current = null;
      return;
    }
    if (!pendingLoaded || pendingError) return;
    const key = `${network}:${wallet}`;
    if (autoRecheckWallet.current === key) return;
    autoRecheckWallet.current = key;
    void recheckPending();
  }, [connected, wallet, pendingLoaded, pendingError, network, recheckPending]);

  function resolveBatchApproval(approved: boolean) {
    const resolve = approvalResolver.current;
    approvalResolver.current = null;
    resolve?.(approved);
  }

  function requestBatchApproval(
    prepared: PreparedCloseBatch,
    total: number,
    index: number,
    feePayerBalance: bigint,
    confirmedBatches: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      approvalResolver.current = resolve;
      const net = prepared.grossRentLamports - prepared.serviceFeeLamports - prepared.estimatedNetworkFeeLamports;
      setState({
        status: "review",
        total,
        current: index + 1,
        confirmed: confirmedBatches,
        accountCount: prepared.accounts.length,
        gross: prepared.grossRentLamports,
        serviceFee: prepared.serviceFeeLamports,
        serviceFeeBps: prepared.serviceFeeBps,
        networkFee: prepared.estimatedNetworkFeeLamports,
        net,
        feePayerBalance,
        treasuryAddress: prepared.treasuryAddress,
      });
    });
  }

  async function scan() {
    if (!wallet || !connected || scanning || running.current) return;
    setScanning(true); setError(null); setResult(null); setSelected([]); setHarvestConsent(false); setBurnConsent(false); setState({ status: "idle" });
    try {
      await assertConnectionNetwork(connection, network);
      const next = await scanWallet(wallet, connection);
      if (publicKey?.toBase58() === wallet) { setResult(next); setScannedWallet(wallet); }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet scan failed. Check the RPC connection.");
    } finally { setScanning(false); }
  }

  async function executeSelected() {
    if (!wallet || !publicKey || !connected || typeof signTransaction !== "function" ||
      running.current || scanning || chosen.length === 0 ||
      chosen.some((row) => walletPending.some((item) => item.accountAddress === row.address)) ||
      (selectedWithheldCount > 0 && !harvestConsent) ||
      (selectedBurnCount > 0 && !burnConsent) ||
      !pendingLoaded || pendingError) return;

    const treasury = process.env.NEXT_PUBLIC_TREASURY_ADDRESS;
    const feeValue = process.env.NEXT_PUBLIC_RECLAIMSOL_SERVICE_FEE_BPS;
    if (!treasury || !feeValue || !/^\d+$/.test(feeValue)) { setError("Service treasury or fee configuration is missing."); return; }
    const serviceFeeBps = Number(feeValue);
    if (!Number.isSafeInteger(serviceFeeBps) || serviceFeeBps < 1 || serviceFeeBps >= 10000) { setError("Service fee configuration is invalid."); return; }

    running.current = true; setError(null); setState({ status: "planning" });
    const config = {
      walletAddress: wallet,
      accountAddresses: chosen.map((row) => row.address),
      harvestAccountAddresses: chosen
        .filter((row) => BigInt(row.withheldAmount) > BigInt(0))
        .map((row) => row.address),
      burnAccountAddresses: chosen
        .filter((row) => row.tokenAmount !== null && BigInt(row.tokenAmount) > BigInt(0))
        .map((row) => row.address),
      connection,
      treasuryAddress: treasury,
      serviceFeeBps,
    };
    const signatures: string[] = [];
    const reconciliations: ReconciledBatch[] = [];
    let activeSignature: string | undefined;
    let confirmed = 0;
    let total = 0;
    let currentIndex = 0;
    let cancelledByUser = false;

    try {
      await assertConnectionNetwork(connection, network);
      const batches = await planCloseAccountBatches(config);
      total = batches.length;
      setState({ status: "running", total, current: 0, confirmed });

      const outcome = await executeBatchLifecycle({
        batches,
        prepareBatch: async (batch, index) => {
          currentIndex = index;
          if (publicKey?.toBase58() !== wallet) throw new Error("Wallet changed. Batch execution stopped.");
          await assertConnectionNetwork(connection, network);
          setState({ status: "running", total, current: index + 1, confirmed });
          return prepareCloseAccountBatch(config, batch, index);
        },
        executeBatch: async (prepared: PreparedCloseBatch) => {
          await assertConnectionNetwork(connection, network);
          validatePreparedCloseBatch(prepared, wallet, serviceFeeBps, treasury);
          const estimatedNetworkFee = prepared.estimatedNetworkFeeLamports;
          const initialFeePayerBalance = BigInt(await connection.getBalance(new PublicKey(wallet), "confirmed"));
          validateBatchEconomics({
            grossRentLamports: prepared.grossRentLamports,
            serviceFeeLamports: prepared.serviceFeeLamports,
            estimatedNetworkFeeLamports: estimatedNetworkFee,
            feePayerBalanceLamports: initialFeePayerBalance,
          });

          const approved = await requestBatchApproval(prepared, total, currentIndex, initialFeePayerBalance, confirmed);
          if (!approved) {
            cancelledByUser = true;
            throw new Error("You cancelled this batch before wallet signing. No transaction was sent for this batch.");
          }

          if (!walletStateRef.current.connected || walletStateRef.current.wallet !== wallet) {
            throw new Error("Wallet disconnected or changed during batch review. No transaction was signed.");
          }

          const latestFeePayerBalance = BigInt(await connection.getBalance(new PublicKey(wallet), "confirmed"));
          validateBatchEconomics({
            grossRentLamports: prepared.grossRentLamports,
            serviceFeeLamports: prepared.serviceFeeLamports,
            estimatedNetworkFeeLamports: estimatedNetworkFee,
            feePayerBalanceLamports: latestFeePayerBalance,
          });

          // The user may take time to review the amounts. Re-read all affected
          // accounts and obtain a new blockhash only after approval, immediately
          // before opening Phantom. No old blockhash is carried through review.
          const signingPrepared = await refreshPreparedCloseBatchForSigning(config, prepared);
          validatePreparedCloseBatch(signingPrepared, wallet, serviceFeeBps, treasury);

          // Preserve an independent immutable snapshot before calling the wallet.
          // Some wallet adapters may mutate the transaction object they receive.
          // Snapshot the prepared legacy message, then hand Phantom a native
          // web3.js Transaction (not a VersionedTransaction carrying a legacy message).
          const originalTransaction = VersionedTransaction.deserialize(signingPrepared.transaction.serialize());
          const originalMessage = originalTransaction.message.serialize();
          const walletFacingTransaction = toWalletLegacyTransaction(originalTransaction);
          let signedResult: Transaction | VersionedTransaction;
          if (signingMethodRef.current === "provider") {
            const phantomProvider = (window as Window & {
              phantom?: {
                solana?: {
                  isPhantom?: boolean;
                  publicKey?: PublicKey | null;
                  signTransaction?: (transaction: Transaction) => Promise<Transaction>;
                };
              };
            }).phantom?.solana;
            if (!phantomProvider?.isPhantom || typeof phantomProvider.signTransaction !== "function") {
              throw new Error("Direct Phantom provider is unavailable. Connect Phantom directly and retry; no transaction was sent.");
            }
            if (phantomProvider.publicKey?.toBase58() !== wallet) {
              throw new Error("Direct Phantom provider account does not match the connected wallet-adapter account. No transaction was signed or sent.");
            }
            signedResult = await phantomProvider.signTransaction(walletFacingTransaction);
          } else {
            signedResult = await signTransaction(walletFacingTransaction);
          }
          // Normalize cross-realm web3.js Transaction objects returned by the
          // injected Phantom provider. The parsed bytes remain subject to the
          // exact message, signer, and Ed25519 checks below.
          const signed = normalizeWalletSignedTransaction(signedResult);
          const signedCompiledMessage = signed.compileMessage();
          const signedMessage = signed.serializeMessage();
          if (originalMessage.length !== signedMessage.length || !originalMessage.every((byte, i) => byte === signedMessage[i])) {
            const lighthouseValidation = validatePhantomLighthouseTransaction(
              originalTransaction.message as Message,
              signedCompiledMessage,
              wallet,
              signingPrepared.accounts.map((account) => account.address),
            );
            if (!lighthouseValidation.ok) {
              const changes = describeTransactionMessageChanges(originalTransaction.message, signedCompiledMessage);
              const details = changes.length > 0 ? changes.join("; ") : "serialized message changed in an unclassified field";
              throw new Error(`Wallet modified the transaction message and did not match the strict Phantom Lighthouse allowlist (${lighthouseValidation.reason}). It was not sent. Details: ${details}`);
            }
          }

          if (signedCompiledMessage.header.numRequiredSignatures !== 1 || signed.signatures.length !== 1 || !signed.signatures[0].publicKey.equals(new PublicKey(wallet))) throw new Error("Unexpected signer configuration. Transaction was not sent.");
          const walletSignature = signed.signatures[0].signature;
          let valid = false;
          try { valid = !!walletSignature && walletSignature.length === 64 && ed25519.verify(walletSignature, signedMessage, new PublicKey(wallet).toBytes(), { zip215: false }); } catch { valid = false; }
          if (!valid) throw new Error("Wallet signature verification failed. Transaction was not sent.");

          const signature = getSignedTransactionSignature(signed);
          if (await connection.getBlockHeight("confirmed") > signingPrepared.lastValidBlockHeight) throw new Error("Transaction expired after signing. It was not sent.");

          const records = signingPrepared.accounts.map((account) => createPendingTransaction({
            network,
            walletAddress: wallet,
            accountAddress: account.address,
            signature,
            treasuryAddress: treasury,
            grossRentLamports: signingPrepared.grossRentLamports.toString(),
            serviceFeeLamports: signingPrepared.serviceFeeLamports.toString(),
            serviceFeeBps,
            accountRentLamports: account.rentLamports.toString(),
            blockhash: signingPrepared.blockhash,
            lastValidBlockHeight: signingPrepared.lastValidBlockHeight,
          }));
          // If this atomic write fails, activeSignature stays unset and nothing is sent.
          savePendingTransactions(window.localStorage, records);
          setPending(readPendingTransactions(window.localStorage));
          activeSignature = signature;

          const sentSignature = await connection.sendRawTransaction(signed.serialize(), { preflightCommitment: "confirmed", maxRetries: 3 });
          if (sentSignature !== signature) throw new Error("RPC returned a signature different from the verified wallet signature.");
          const confirmation = await confirmTransactionWithStatusFallback(connection, {
            signature,
            blockhash: signingPrepared.blockhash,
            lastValidBlockHeight: signingPrepared.lastValidBlockHeight,
          });
          if (confirmation.status === "failed") {
            throw new Error(`Transaction failed on Solana: ${JSON.stringify(confirmation.error)}`);
          }
          if (confirmation.status === "unknown") {
            throw new Error(`${confirmation.reason} The transaction was sent; do not submit this batch again until its status is verified.`);
          }

          const resolution = await resolvePendingTransactionGroup(
            window.localStorage, records,
            (sig) => inspectTransactionOutcome(connection, sig),
            (address) => connection.getAccountInfo(new PublicKey(address), "confirmed"),
            async (group) => {
              const reconciled = await reconcilePendingGroup(group);
              const first = group[0];
              if (!first) throw new Error("Pending transaction group is empty.");
              reconciliations.push({ signature: first.signature, ...reconciled });
              return reconciled;
            },
            async (group) => {
              const first = group[0];
              if (!first?.blockhash || first.lastValidBlockHeight === undefined ||
                group.some((item) => item.blockhash !== first.blockhash || item.lastValidBlockHeight !== first.lastValidBlockHeight)) return false;
              const currentBlockHeight = await connection.getBlockHeight("confirmed");
              if (currentBlockHeight <= first.lastValidBlockHeight) return false;
              for (const item of group) {
                // An expired transaction cannot land later. A missing account is already closed;
                // an existing account must still be a token account owned by this wallet.
                const response = await connection.getParsedAccountInfo(new PublicKey(item.accountAddress), "confirmed");
                const account = response.value;
                if (account === null) continue;
                if (!account.owner.equals(TOKEN_PROGRAM_ID) && !account.owner.equals(TOKEN_2022_PROGRAM_ID)) return false;
                const parsed = account.data as unknown as { program?: string; parsed?: { type?: string; info?: { owner?: string } } };
                if ((parsed.program !== "spl-token" && parsed.program !== "spl-token-2022") ||
                  parsed.parsed?.type !== "account" || parsed.parsed.info?.owner !== wallet) return false;
              }
              return true;
            },
          );
          if (resolution !== "resolved") throw new Error("Transaction is confirmed, but its financial metadata and every account closure have not been fully reconciled. Do not retry this batch.");
          setPending(readPendingTransactions(window.localStorage));
          signatures.push(signature);
          activeSignature = undefined;
          confirmed += 1;
          setState({ status: "running", total, current: currentIndex + 1, confirmed });
          return { signature, accountCount: signingPrepared.accounts.length };
        },
      });

      if (outcome.status === "failed") {
        const cause = outcome.error;
        const message = cause instanceof Error ? cause.message : "Batch execution stopped.";
        if (cancelledByUser) {
          setState({ status: "cancelled", total, confirmed, cancelledIndex: outcome.failedBatchIndex + 1 });
        } else if (activeSignature) {
          const status = await inspectTransactionOutcome(connection, activeSignature);
          setState({ status: status.status === "confirmed" ? "verifying" : status.status, total, confirmed, failedIndex: outcome.failedBatchIndex + 1, message: status.status === "confirmed" ? "The transaction is confirmed on Solana. Final account and balance checks are still pending." : message, signature: activeSignature });
        } else {
          setState({ status: "failed", total, confirmed, failedIndex: outcome.failedBatchIndex + 1, message });
        }
      } else {
        setState({ status: "completed", total, signatures, reconciliations });
        setSelected([]);
        const refreshed = await scanWallet(wallet, connection);
        if (publicKey?.toBase58() === wallet) { setResult(refreshed); setScannedWallet(wallet); }
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Batch execution failed.";
      if (cancelledByUser) {
        setState({ status: "cancelled", total, confirmed, cancelledIndex: currentIndex + 1 });
      } else if (activeSignature) {
        const status = await inspectTransactionOutcome(connection, activeSignature);
        setState({ status: status.status === "confirmed" ? "verifying" : status.status, total, confirmed, failedIndex: currentIndex + 1, message: status.status === "confirmed" ? "The transaction is confirmed on Solana. Final account and balance checks are still pending." : message, signature: activeSignature });
      } else {
        setState({ status: "failed", total, confirmed, failedIndex: currentIndex + 1, message });
      }
    } finally {
      running.current = false;
      try {
        const stored = readPendingTransactions(window.localStorage);
        if (wallet && stored.some((item) => item.network === network && item.walletAddress === wallet)) {
          void recheckPending();
        }
      } catch {
        // The normal pending-storage warning keeps the user informed.
      }
    }
  }

  return <div className="scanner">
    <div className="scanner-toolbar">
      <div><div className="scanner-toolbar-title">Token account scanner</div><div className="scanner-toolbar-subtitle">SPL Token and Token-2022 · read-only scan</div></div>
      <button className="wallet-button scanner-button" type="button" onClick={() => void scan()} disabled={!connected || scanning || busy}>{scanning ? "Scanning…" : result ? "Scan again" : "Scan wallet"}</button>
    </div>

    {pendingError && <div className="scanner-preparation scanner-preparation-error" role="alert"><strong>Pending recovery storage unavailable</strong><p>{pendingError}</p><p>Batch execution is blocked to prevent duplicate transactions.</p></div>}
    {walletPending.length > 0 && <div className="scanner-preparation scanner-preparation-error" role="status">
      <strong>{recheckingPending ? "Verifying previous transaction…" : "Previous transaction needs verification"}</strong>
      <p>ReclaimSOL checks the transaction signature, actual balance movements and every affected account. Accounts in this pending transaction stay protected; other eligible accounts can still be selected and processed.</p>
      {groupPendingTransactions(walletPending).map((group) => <div key={group[0].signature}>
        <p><a href={explorer(group[0].signature, network)} target="_blank" rel="noreferrer">Open transaction in Solana Explorer</a> · {group.length} account(s)</p>
        {group.every((item) => !item.blockhash && item.lastValidBlockHeight === undefined) && <button className="wallet-button scanner-prepare-button" type="button" onClick={() => void releaseLegacyPendingGroup(group)} disabled={busy || recheckingPending || legacyRecoverySignature !== null}>{legacyRecoverySignature === group[0].signature ? "Verifying old record…" : "Recover old pending lock"}</button>}
      </div>)}
      {legacyRecoveryError && <p className="scanner-error" role="alert">{legacyRecoveryError}</p>}
      <button className="wallet-button scanner-prepare-button" type="button" onClick={() => void recheckPending()} disabled={busy || recheckingPending || legacyRecoverySignature !== null}>{recheckingPending ? "Checking…" : "Check transaction again"}</button>
    </div>}
    {!connected && <p className="scanner-message">Connect your Solana wallet above to start a read-only scan.</p>}
    {error && <p className="scanner-error" role="alert">{error}</p>}
    {scanning && <p className="scanner-message" aria-live="polite">Reading SPL Token and Token-2022 accounts from Solana…</p>}

    {result && scannedWallet === wallet && <>
      <div className="scanner-stats">
        <article className="scanner-stat scanner-stat-highlight"><span>Eligible account rent</span><strong>{formatLamports(eligible.reduce((sum, row) => sum + row.lamports, BigInt(0)))} SOL</strong><small>Potential recovery before fees</small></article>
        <article className="scanner-stat"><span>Eligible accounts</span><strong>{eligible.length}</strong><small>Empty and supported</small></article>
        <article className="scanner-stat"><span>Needs review</span><strong>{result.rows.filter((row) => ["review_required", "unsupported", "scan_error"].includes(row.status)).length}</strong><small>Not included in batch</small></article>
        <article className="scanner-stat"><span>Contains tokens</span><strong>{result.rows.filter((row) => row.status === "has_tokens").length}</strong><small>Available for explicit burn + close</small></article>
      </div>
      <div className="scanner-result-meta"><span>Wallet balance: {formatLamports(result.walletLamports)} SOL</span><span>Accounts scanned: {result.rows.length}</span>{result.warnings > 0 && <span className="scanner-warning">{result.warnings} decode warning(s)</span>}</div>

      {selectable.length > 0 && <div className="scanner-preparation">
        <div className="scanner-toolbar"><div><strong>Select accounts to process</strong><p>Each account is re-read immediately before its batch is prepared.</p></div>
          <button className="wallet-button scanner-prepare-button" type="button" disabled={busy} onClick={() => { const selectedCount = selected.filter((address) => selectable.some((row) => row.address === address)).length; setSelected(selectedCount === selectable.length ? selected.filter((address) => !selectable.some((row) => row.address === address)) : [...new Set([...selected, ...selectable.map((row) => row.address)])]); setHarvestConsent(false); setBurnConsent(false); setState({ status: "idle" }); }}>{selected.filter((address) => selectable.some((row) => row.address === address)).length === selectable.length ? "Deselect all" : "Select all supported"}</button>
        </div>
        <div className="scanner-result-meta"><span>Selected: {chosen.length}</span><span>Gross: {formatLamports(gross)} SOL</span><span>Service fee ({(bps / 100).toFixed(2)}%): {formatLamports(fee)} SOL</span><span>Net before network fees: {formatLamports(gross - fee)} SOL</span></div>
        {selectedBurnCount > 0 && <label className="scanner-harvest-consent">
          <input type="checkbox" checked={burnConsent} onChange={(event) => setBurnConsent(event.target.checked)} disabled={busy} />
          I understand: ReclaimSOL will irreversibly burn the entire token balance in {selectedBurnCount} selected account(s), then close those accounts. Burned tokens cannot be recovered. I have checked these assets and authorize their destruction.
        </label>}
        {selectedWithheldCount > 0 && <label className="scanner-harvest-consent">
          <input type="checkbox" checked={harvestConsent} onChange={(event) => setHarvestConsent(event.target.checked)} disabled={busy} />
          I understand: withheld Token-2022 fees will be harvested to the token mint, not to my wallet, before closing.
        </label>}
        <button className="wallet-button scanner-button" type="button" disabled={!connected || chosen.length === 0 || (selectedWithheldCount > 0 && !harvestConsent) || (selectedBurnCount > 0 && !burnConsent) || busy || !pendingLoaded || !!pendingError || chosen.some((row) => walletPending.some((item) => item.accountAddress === row.address))} onClick={() => void executeSelected()}>{state.status === "planning" ? "Planning…" : busy ? "Processing batches…" : selectedBurnCount > 0 ? `Burn tokens & close ${chosen.length} account(s)` : selectedWithheldCount > 0 ? `Harvest fees & close ${chosen.length} account(s)` : `Close ${chosen.length} selected account(s)`}</button>
        <p className="scanner-preparation-notice">Every batch is simulated and signed separately. The next batch is prepared only after the previous batch is confirmed and all its accounts are verified closed. Service fee transfers atomically with account closure; network fees are separate and priority fee is zero.</p>
      </div>}

      {state.status === "planning" && <div className="scanner-preparation" role="status">Planning transaction batches…</div>}
      {state.status === "running" && <div className="scanner-preparation" role="status"><strong>Batch {state.current} of {state.total}</strong><p>Confirmed batches: {state.confirmed}. Preparing and verifying the next transaction.</p></div>}
      {state.status === "review" && <div className="scanner-preparation" role="group" aria-label="Review prepared transaction">
        <strong>Review batch {state.current} of {state.total} before wallet signing</strong>
        <p>Accounts in this transaction: {state.accountCount}</p>
        <p>Gross rent: {formatLamports(state.gross)} SOL</p>
        <p>Service fee ({(state.serviceFeeBps / 100).toFixed(2)}%): {formatLamports(state.serviceFee)} SOL</p>
        <p>Service treasury: <span title={state.treasuryAddress}>{short(state.treasuryAddress)}</span></p>
        <p>Estimated network fee: {formatLamports(state.networkFee)} SOL</p>
        <p><strong>Estimated net recovery: {formatLamports(state.net)} SOL</strong></p>
        <p>Current fee-payer balance: {formatLamports(state.feePayerBalance)} SOL. Recovered rent is not counted toward the upfront network-fee balance check.</p>
        {diagnosticsEnabled && <div className="scanner-wallet-diagnostic" aria-label="Phantom signing API diagnostic">
          <strong>Phantom signing path diagnostic (one batch at a time)</strong>
          <small>Detected wallet adapter: {selectedWallet?.adapter.name ?? "unknown"}</small>
          <label><input type="radio" name="phantom-signing-method" checked={signingMethod === "adapter"} onChange={() => changeSigningMethod("adapter")} /> Wallet Adapter signTransaction (current path)</label>
          <label><input type="radio" name="phantom-signing-method" checked={signingMethod === "provider"} onChange={() => changeSigningMethod("provider")} /> Direct window.phantom.solana.signTransaction (diagnostic)</label>
          <small>Both paths retain exact message equality, signer verification and Ed25519 signature verification. Any unexpected change blocks sending. Direct provider mode is a diagnostic legacy API path, not the default integration.</small>
        </div>}
        <button className="wallet-button scanner-button" type="button" onClick={() => resolveBatchApproval(true)}>Approve batch and open wallet</button>
        <button className="wallet-button scanner-prepare-button" type="button" onClick={() => resolveBatchApproval(false)}>Cancel remaining recovery</button>
      </div>}
      {state.status === "cancelled" && <div className="scanner-preparation" role="status"><strong>Recovery cancelled</strong><p>Stopped before signing batch {state.cancelledIndex}. {state.confirmed} earlier batch(es) remain confirmed; they were not repeated.</p></div>}
      {state.status === "completed" && <div className="scanner-preparation scanner-preparation-success" role="status"><strong>Recovery completed</strong><p>{state.signatures.length} batch(es) confirmed, transaction metadata reconciled, and every included account verified closed.</p>{state.reconciliations.map((item) => <p key={item.signature}><a href={explorer(item.signature, network)} target="_blank" rel="noreferrer">View confirmed transaction</a><br />Actual network fee: {formatLamports(item.actualNetworkFeeLamports)} SOL · Net recovered: {formatLamports(item.actualNetRecoveredLamports)} SOL</p>)}</div>}
      {state.status === "verifying" && <div className="scanner-preparation scanner-preparation-verifying" role="status"><strong>Transaction confirmed — finishing verification</strong><p>{state.message} The affected accounts remain protected from duplicate processing.</p><p><a href={explorer(state.signature, network)} target="_blank" rel="noreferrer">Open transaction in Solana Explorer</a></p></div>}
      {(state.status === "failed" || state.status === "unknown") && <div className="scanner-preparation scanner-preparation-error" role="alert"><strong>{state.status === "unknown" ? "Transaction needs verification" : `Batch ${state.failedIndex} stopped`}</strong><p>{state.status === "unknown" ? "We have not confirmed the final result yet. The batch stays protected while ReclaimSOL checks the signature and affected accounts." : state.message}</p>{state.message.includes("Wallet modified the transaction message") && <details className="scanner-wallet-diagnostic-details"><summary>Inspect exact wallet changes</summary><pre>{state.message}</pre></details>}<p>Please do not submit this same batch again until verification is complete.</p>{state.signature && <p><a href={explorer(state.signature, network)} target="_blank" rel="noreferrer">Open transaction in Solana Explorer</a></p>}</div>}

      {result.rows.length === 0 ? <div className="scanner-empty">No SPL Token or Token-2022 accounts were found.</div> : <div className="scanner-list">
        {result.rows.map((row) => <TokenAccountCard key={row.address} row={row} selected={selected.includes(row.address)} disabled={busy || walletPending.some((item) => item.accountAddress === row.address)} onToggle={(checked) => { setSelected((current) => checked ? [...new Set([...current, row.address])] : current.filter((value) => value !== row.address)); setBurnConsent(false); setHarvestConsent(false); setState({ status: "idle" }); }} />)}
      </div>}
    </>}

    <div className="scanner-disclaimer">Burning is irreversible and destroys the full token balance; token market value is not assessed by this scanner. Only select assets you intentionally want to destroy. Scanning is read-only. Selected accounts are revalidated before signing. A batch is sent only after signature verification and atomic pending-record persistence. Unknown outcomes remain blocked until verified. Actual recovery is shown only after confirmed on-chain execution.</div>
  </div>;
}