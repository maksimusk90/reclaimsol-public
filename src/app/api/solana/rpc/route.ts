import { NextRequest, NextResponse } from "next/server";
import { getHeliusEndpoints, shouldFailOver, validateMainnetRpcPayload } from "@/lib/reclaim/helius-rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 12_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 600;
const requestCounts = new Map<string, { count: number; resetAt: number }>();

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: { message } }, { status, headers: { "Cache-Control": "no-store" } });
}
function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const configuredAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!configuredAppUrl) return false;
  try {
    return new URL(origin).origin === new URL(configuredAppUrl).origin;
  } catch {
    return false;
  }
}
function rateLimited(request: NextRequest): boolean {
  const now = Date.now();
  const key = request.headers.get("x-real-ip")?.slice(0, 64) || "unknown";
  const current = requestCounts.get(key);
  if (!current || current.resetAt <= now) {
    requestCounts.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    if (requestCounts.size > 10_000) for (const [entry, value] of requestCounts) if (value.resetAt <= now) requestCounts.delete(entry);
    return false;
  }
  current.count += 1;
  return current.count > RATE_LIMIT;
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return jsonError("Cross-origin RPC requests are not allowed.", 403);
  if (rateLimited(request)) return jsonError("RPC proxy rate limit reached. Try again shortly.", 429);
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) return jsonError("RPC request is too large.", 413);

  let payload: unknown;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return jsonError("RPC request is too large.", 413);
    payload = JSON.parse(raw);
  } catch { return jsonError("Request body must be valid JSON.", 400); }
  const invalid = validateMainnetRpcPayload(payload);
  if (invalid) return jsonError(invalid, 403);

  let endpoints: string[];
  try { endpoints = getHeliusEndpoints(); }
  catch (error) { return jsonError(error instanceof Error ? error.message : "Invalid RPC configuration.", 503); }
  if (endpoints.length === 0) return jsonError("Mainnet Helius RPC is not configured on the server.", 503);

  let lastFailure = "Helius RPC endpoints are unavailable.";
  for (const endpoint of endpoints) {
    try {
      const upstream = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload), cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const raw = await upstream.text();
      let body: unknown;
      try { body = JSON.parse(raw); } catch { body = null; }
      if (upstream.status === 429) return jsonError("Helius rate limit reached. The fallback account will not be used to bypass provider quotas.", 429);
      if (shouldFailOver(upstream.status)) { lastFailure = `Helius RPC returned HTTP ${upstream.status}.`; continue; }
      if (!upstream.ok) return jsonError(`Helius RPC request failed with HTTP ${upstream.status}.`, 502);
      if (body && typeof body === "object" && "error" in body) {
        const rpcError = (body as { error?: { message?: unknown } }).error;
        if (typeof rpcError?.message === "string" && /rate.?limit|too many requests/i.test(rpcError.message)) {
          return jsonError("Helius rate limit reached. The fallback account will not be used to bypass provider quotas.", 429);
        }
      }
      if (body === null) return jsonError("Helius RPC returned an invalid response.", 502);
      return NextResponse.json(body, { status: 200, headers: { "Cache-Control": "no-store" } });
    } catch { lastFailure = "Helius RPC endpoint timed out or could not be reached."; }
  }
  return jsonError(lastFailure, 502);
}