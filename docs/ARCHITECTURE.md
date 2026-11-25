# Architecture — ReclaimSOL

## 1. Architecture principles
- Non-custodial: wallet signs user-authorized transactions.
- Client-first transaction construction and signing.
- Backend is a thin RPC/configuration boundary, not a signing service.
- No database in MVP.
- All monetary arithmetic uses lamports as integers.
- Scanner, classifier, calculator, batch manager, transaction builder, and verifier are independently testable.
- RPC data is untrusted input and must be decoded/validated.

## 2. Proposed stack
- Next.js App Router
- React + TypeScript strict mode
- Tailwind CSS + shadcn/ui (or equivalent accessible component primitives)
- Solana Wallet Adapter, with Phantom supported first
- Solana web3.js / SPL Token packages selected and pinned after a compatibility spike
- Vitest for unit/integration tests
- Playwright for browser-level tests
- Hosted RPC provider configured by environment variable
- VPS deployment behind Nginx + HTTPS, if owner chooses VPS

Do not assume a specific package major version. Before implementation, verify current official package compatibility, API shape, transaction-format support, and wallet support. Pin versions in the lockfile.

## 3. High-level components

### Frontend
- `WalletProvider`: wallet connection, public key, network.
- `ScanController`: scan lifecycle and cancellation.
- `AccountList`: eligible/excluded account presentation and selection.
- `RecoverySummary`: gross, service fee, network estimate, net.
- `BatchController`: sequential batches, pause/resume, progress.
- `TransactionReview`: exact accounts, destination, treasury, fee and network cost.
- `TransactionStatus`: signature, confirmation, error and verification.

### Domain modules
- `scanner`: fetch token accounts for supported token program IDs.
- `decoder`: decode account state using the appropriate program-aware SDK.
- `classifier`: determine eligibility and exclusion reason.
- `calculator`: integer lamport calculations.
- `batch-manager`: create batches of up to 8 accounts and execute sequentially without an arbitrary run-count cap.
- `transaction-builder`: close instructions, treasury transfer, compute budget policy, simulation.
- `transaction-sender`: wallet interaction and RPC submission.
- `verifier`: confirmation, account existence checks, actual transaction metadata.
- `config`: validated program IDs, treasury address, network, limits.

### Backend
MVP backend responsibilities should be minimal:
- Serve public configuration that is safe to expose (network label, treasury address, supported program IDs, batch policy).
- Optional server-side RPC proxy if RPC credentials must not be exposed to the browser.
- Rate limiting and request validation if public API routes are used.
- No private keys, no wallet signing, no user custody.

Do not put wallet scanning behind a backend solely for architectural fashion. Decide whether direct client RPC or a thin RPC proxy is appropriate based on provider CORS, rate limits, and key exposure. A browser-visible RPC API key is not a secret; use provider restrictions and quotas.

## 4. Suggested source layout
```text
src/
  app/
    page.tsx
    app/page.tsx
    terms/page.tsx
    privacy/page.tsx
    api/
  components/
    wallet/
    scanner/
    recovery/
    transactions/
    layout/
  lib/
    solana/
      connection.ts
      programs.ts
      network.ts
    scanner/
      scan-token-accounts.ts
      decode-account.ts
    classifier/
      classify-account.ts
    calculator/
      recovery.ts
      fees.ts
    transactions/
      build-close-batch.ts
      simulate.ts
      submit.ts
      confirm.ts
      verify.ts
    recovery/
      batch-manager.ts
      session-state.ts
    config/
      public-config.ts
      server-config.ts
  types/
tests/
  unit/
  integration/
  e2e/
```

## 5. Scanner flow
1. Receive connected wallet public key.
2. Fetch accounts for canonical SPL Token Program.
3. Fetch accounts for canonical Token-2022 Program.
4. Decode each account using program-aware decoder.
5. Fetch/retain actual lamports from account info.
6. Validate mint/program relationships and account state.
7. Classify into `Reclaimable`, `HasTokens`, `Unauthorized`, `Unsupported`, `ReviewRequired`, `AlreadyClosed`, or `ScanError`.
8. Return a deterministic scan result to UI.
9. Before building each batch, fetch current state again and repeat eligibility checks.

Never use a token's name, symbol, price, logo, or liquidity as proof that it can be closed.

## 6. Fee and transaction design
For a batch:
- Compute gross recovery from current `lamports` of accounts expected to close.
- Compute service fee with integer arithmetic: `floor(gross * 1500 / 10000)`.
- Add one System Program transfer from connected wallet to treasury for that service fee, if fee > 0.
- Each close instruction sends its recovered lamports to the connected wallet.
- User wallet is fee payer and authority signer in the normal supported path.
- Use no priority fee by default.
- Estimate fee from the exact transaction message when possible; show estimate before signing.
- Simulate exact transaction before signing.
- Confirm transaction and inspect metadata after submission.

Important runtime detail: the fee payer must satisfy fee-payer balance validation before transaction execution. Do not assume lamports reclaimed by a later instruction in the same transaction can fund the transaction fee. If the connected wallet cannot pay the network fee upfront, stop and explain the requirement.

Atomicity: all instructions in one transaction succeed or state changes revert. The transaction fee can still be charged on failure.

## 7. Batch manager
Default configuration:
```ts
export const RECOVERY_LIMITS = {
  maxAccountsPerTransaction: 8,
} as const;
```
- Partition selected supported accounts into groups of at most 8.
- Submit/confirm/verify one transaction at a time; there is no fixed run-length cap.
- Never send multiple transactions concurrently.
- Prepare the next transaction only after the previous transaction is confirmed and every included account is verified closed.
- Require an explicit in-app review before each wallet signing prompt; the user may cancel the remaining run.
- Preserve unresolved pending records and block duplicate processing.
- If a transaction failed or its outcome is ambiguous, do not assume account state; re-scan before retry.
- A run may end early if the user cancels, wallet disconnects, network changes, or an account becomes ineligible.

The 8-account ceiling is a conservative product safety limit, not a Solana protocol guarantee. Do not impose an arbitrary transaction-count limit per run.

## Network configuration

- Read `NEXT_PUBLIC_SOLANA_NETWORK` explicitly; only `devnet` and `mainnet-beta` are accepted.
- Resolve the RPC endpoint from the same validated config.
- Verify `getGenesisHash` against the expected cluster genesis hash before scanning and before each transaction preparation/signing flow.
- Derive scanner network namespace, pending-record namespace, Explorer cluster parameter, and visible network labels from the same config.
- A custom RPC URL is not trusted based on its hostname; the returned genesis hash must match.
- The current production deployment is explicitly configured for Mainnet; development and test environments may use Devnet. Keep environment values separate and verify genesis hash before scanning or preparing transactions.

## 8. Wallet API compatibility
- Use the wallet adapter's primary supported transaction send/sign flow.
- Feature-detect optional methods such as `signAllTransactions`.
- Do not assume every wallet implements optional batch-signing APIs.
- Do not use batch signing as the default MVP path.
- Test Phantom desktop/mobile and at least one other adapter if included in scope.
- If a wallet rejects or times out, preserve state and show a recoverable error; do not silently retry signing.

## 9. Transaction formats
- Start with the transaction format supported reliably by the chosen SDK and wallets (likely legacy or v0, based on the selected instructions and account set).
- Solana documentation describes v1 transactions with a 4,096-byte limit and Mainnet activation, but client SDKs, wallet adapters, hardware wallets, RPC providers, and explorers may not all support v1 consistently.
- v1 is an experimental follow-up behind a feature flag. Do not use it to justify increasing batch limits until end-to-end tests pass.
- Do not confuse the v1 format's packet transport changes with a guarantee of higher wallet prompt reliability.

## 10. State model
Suggested account status union:
```ts
type AccountStatus =
  | "reclaimable"
  | "has_tokens"
  | "unauthorized"
  | "unsupported"
  | "review_required"
  | "already_closed"
  | "scan_error";
```

Suggested transaction status:
```ts
type RecoveryTxStatus =
  | "draft"
  | "simulating"
  | "ready_for_signature"
  | "awaiting_signature"
  | "submitted"
  | "confirmed"
  | "failed"
  | "expired"
  | "verification_failed";
```

Persist only in-memory/session state in MVP. Never treat client state as authoritative; revalidate against RPC.

## 11. Error handling
Provide actionable messages for:
- wallet not connected
- wrong network
- wallet disconnected/account changed
- RPC unavailable/rate-limited
- unsupported token extension
- account changed since scan
- account already closed
- account not empty
- insufficient SOL for network fee
- simulation failure
- wallet rejected signature
- transaction expired
- transaction failed on-chain
- confirmation timeout
- post-confirmation verification mismatch

## 12. Observability
- Use structured, redacted logs.
- Do not log secret material (none should exist).
- Avoid retaining wallet addresses in server logs.
- Capture aggregate counts and error classes only if privacy-reviewed.
- Recovery counter must be computed from verified on-chain transactions, not optimistic client events.
