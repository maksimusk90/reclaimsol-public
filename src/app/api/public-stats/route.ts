import { NextResponse } from "next/server";
import { getHeliusEndpoints } from "../../../lib/reclaim/helius-rpc";
import { reconcilePublicRecovery } from "../../../lib/reclaim/public-stats";
import type { ParsedTransaction } from "../../../lib/reclaim/public-stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TREASURY = "4fnyv4J1UqBNQRAYjtAFYFuTyMd63z48xhp1iDZ5TaCM";
const MAX_SIGNATURES = 1000;
const CACHE_SECONDS = 300;

type RpcResponse<T> = { result?: T; error?: { message?: string } };
type SignatureInfo = { signature: string; err: unknown };
type PublicStatsPayload = {
  recoveredSol: string;
  successfulTransactions: number;
  closedAccounts: number;
  indexedTransactions: number;
  complete: boolean;
  updatedAt: string;
};

let cachedStats: PublicStatsPayload | null = null;
let cachedUntil = 0;
let statsInFlight: Promise<PublicStatsPayload> | null = null;

async function rpc<T>(endpoint: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "reclaimsol-public-stats", method, params }),
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Solana RPC returned HTTP ${response.status}.`);
  const payload = (await response.json()) as RpcResponse<T>;
  if (payload.error || payload.result === undefined) throw new Error(payload.error?.message || "Solana RPC returned no result.");
  return payload.result;
}

async function collectPublicStats(): Promise<PublicStatsPayload> {
  const endpoints = getHeliusEndpoints();
  if (!endpoints.length) throw new Error("Mainnet RPC is not configured.");
  let signatures: SignatureInfo[] = [];
  let before: string | undefined;
  let complete = false;

  while (signatures.length < MAX_SIGNATURES) {
    const page = await rpc<SignatureInfo[]>(endpoints[0], "getSignaturesForAddress", [
      TREASURY,
      { limit: Math.min(1000, MAX_SIGNATURES - signatures.length), commitment: "finalized", ...(before ? { before } : {}) },
    ]);
    signatures = signatures.concat(page);
    if (page.length < 1000) {
      complete = true;
      break;
    }
    before = page[page.length - 1]?.signature;
    if (!before) {
      complete = true;
      break;
    }
  }

  let grossLamports = BigInt(0);
  let successfulTransactions = 0;
  let closedAccounts = 0;
  let verificationIncomplete = false;
  const batchSize = 16;

  for (let offset = 0; offset < signatures.length; offset += batchSize) {
    const group = signatures.slice(offset, offset + batchSize);
    const results = await Promise.all(group.map(async (item) => {
      if (item.err !== null) return null;
      try {
        const tx = await rpc<ParsedTransaction | null>(endpoints[0], "getTransaction", [
          item.signature,
          { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
        ]);
        if (!tx) verificationIncomplete = true;
        return reconcilePublicRecovery(tx);
      } catch {
        verificationIncomplete = true;
        return null;
      }
    }));
    for (const result of results) {
      if (!result) continue;
      grossLamports += result.grossLamports;
      successfulTransactions += 1;
      closedAccounts += result.closedAccounts;
    }
  }

  return {
    recoveredSol: `${grossLamports / BigInt(1_000_000_000)}.${(grossLamports % BigInt(1_000_000_000)).toString().padStart(9, "0")}`,
    successfulTransactions,
    closedAccounts,
    indexedTransactions: signatures.length,
    complete: complete && !verificationIncomplete,
    updatedAt: new Date().toISOString(),
  };
}

function statsResponse(data: PublicStatsPayload) {
  return NextResponse.json(data, {
    headers: { "Cache-Control": `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=600` },
  });
}

export async function GET() {
  if (cachedStats && Date.now() < cachedUntil) return statsResponse(cachedStats);

  try {
    if (!statsInFlight) statsInFlight = collectPublicStats();
    const result = await statsInFlight;
    cachedStats = result;
    cachedUntil = Date.now() + CACHE_SECONDS * 1000;
    return statsResponse(result);
  } catch {
    return NextResponse.json({ error: "Public recovery statistics are temporarily unavailable." }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  } finally {
    statsInFlight = null;
  }
}
