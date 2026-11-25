"use client";

import { useEffect, useState } from "react";

type PublicStats = {
  recoveredSol: string;
  successfulTransactions: number;
  closedAccounts: number;
  indexedTransactions: number;
  complete: boolean;
  updatedAt: string;
};

function formatSol(value: string) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(amount);
}

export function PublicStats() {
  const [stats, setStats] = useState<PublicStats | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/public-stats", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Statistics are temporarily unavailable.");
        return response.json() as Promise<PublicStats>;
      })
      .then((data) => {
        setStats(data);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setStatus("unavailable");
      });
    return () => controller.abort();
  }, []);

  return (
    <section className="public-stats" aria-labelledby="public-stats-title">
      <div className="public-stats-orbit public-stats-orbit-one" aria-hidden="true" />
      <div className="public-stats-orbit public-stats-orbit-two" aria-hidden="true" />
      <div className="public-stats-header">
        <div>
          <div className="section-label">ON-CHAIN RECONCILED ACTIVITY</div>
          <h2 id="public-stats-title">SOL returned to its owners</h2>
          <p>Gross rent released from closed accounts, reconciled against finalized Solana transactions.</p>
        </div>
        <span className="stats-live"><span /> MAINNET DATA</span>
      </div>
      <div className="public-stats-grid" aria-live="polite">
        <article className="public-stat-primary">
          <span className="public-stat-label">Gross rent recovered</span>
          <div className="public-stat-number">{status === "ready" && stats ? formatSol(stats.recoveredSol) : "—"} <small>SOL</small></div>
          <span className="public-stat-foot">{status === "loading" ? "Checking confirmed transactions…" : status === "unavailable" ? "Live verification temporarily unavailable" : stats?.complete ? "All matching finalized recovery transactions in indexed history" : "Matching transactions verified in the available history"}</span>
          <div className="public-stat-glow" aria-hidden="true" />
        </article>
        <article className="public-stat-card">
          <span className="public-stat-label">Successful recoveries</span>
          <strong>{status === "ready" && stats ? stats.successfulTransactions.toLocaleString("en-US") : "—"}</strong>
          <span className="public-stat-foot">Finalized and reconciled</span>
        </article>
        <article className="public-stat-card">
          <span className="public-stat-label">Accounts closed</span>
          <strong>{status === "ready" && stats ? stats.closedAccounts.toLocaleString("en-US") : "—"}</strong>
          <span className="public-stat-foot">Finalized token-account closures</span>
        </article>
      </div>
      <div className="public-stats-bottom">
        <span>Matched to on-chain fee transfers, closures and wallet balance changes</span>
        <a href="https://explorer.solana.com/address/4fnyv4J1UqBNQRAYjtAFYFuTyMd63z48xhp1iDZ5TaCM?cluster=mainnet-beta" target="_blank" rel="noreferrer">Verify treasury activity ↗</a>
        <span>{status === "ready" && stats ? `Updated ${new Date(stats.updatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC` : status === "unavailable" ? "Statistics will retry on page reload" : "Loading on-chain records"}</span>
      </div>
    </section>
  );
}
