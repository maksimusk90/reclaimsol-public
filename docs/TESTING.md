# Testing Plan — ReclaimSOL

## 1. Test layers
- Unit: arithmetic, classifier, batch manager, configuration.
- Integration: RPC decoding, instruction building, simulation, confirmation, verification.
- E2E: connect wallet, scan, select, review, sign, confirm, display result.
- Manual: Phantom desktop/mobile and any additional wallet explicitly supported.

## 2. Unit tests

### Fee calculator
Test:
- 1,460,000 lamports gross -> 219,000 lamports service fee.
- 15% floor rounding for amounts not divisible by 10,000.
- Zero gross -> zero service fee.
- No minimum fee.
- No maximum fee.
- Large integer values without precision loss.
- Net = gross - service fee - network fee.
- Net <= 0 disables recovery.
- Network fee estimate is separate from service fee.

### Account classifier
Test:
- SPL account with zero amount and authorized owner -> eligible if all other checks pass.
- Token-2022 supported account with zero amount -> eligible if all extension checks pass.
- Any non-zero amount -> `has_tokens`.
- Unknown extension -> `unsupported`.
- Wrong program owner -> not eligible.
- Missing close authority / unauthorized wallet -> `unauthorized`.
- Missing account -> `already_closed`.
- Malformed data / RPC error -> `scan_error` or `review_required`.
- Frozen account follows conservative MVP policy.
- Wrapped SOL/native account excluded from generic flow.

### Batch manager
Test:
- 1–8 accounts -> one batch.
- 9–16 -> two batches.
- 17–24 -> three batches.
- 25+ -> continue in additional sequential batches; no arbitrary run cap.
- Never more than 8 accounts per transaction.
- Six or more batches may complete in one run when each preceding batch is confirmed and verified closed.
- Sequential execution only.
- User cancellation stops future batches.
- Wallet disconnect stops the run.
- Failed batch does not count as recovered.
- Resume revalidates accounts and skips already closed accounts.

## 3. Transaction builder tests
- Every close destination is connected wallet.
- Treasury destination equals configured treasury.
- Client-provided treasury value is ignored/rejected.
- Service fee instruction amount equals integer calculator result.
- No service transfer for zero gross recovery.
- No priority fee instruction by default.
- Non-empty account cannot enter builder without explicit burn consent; with consent, verify exact full-balance `BurnChecked` then `CloseAccount`.
- Unsupported extension cannot enter builder.
- More than 8 accounts rejected by builder.
- Unexpected instruction causes a hard failure.
- Fee payer is connected wallet.
- Transaction size is checked after compilation/serialization.

## 4. Integration scenarios
1. Create an empty SPL token account on Devnet and close it.
2. Create an empty Token-2022 account with a supported configuration and close it.
3. Attempt to process a non-empty account without burn consent; verify preparation is blocked. Repeat with explicit consent and verify full-balance burn precedes close.
4. Attempt an unsupported Token-2022 extension; verify fail-closed behavior.
5. Simulate a transaction with an invalid account; ensure wallet signing is not requested.
6. Execute a successful close + treasury transfer; verify exact lamport balances.
7. Execute a failing transaction; verify treasury receives no service fee and state changes revert, while network fee behavior is correctly represented.
8. Disconnect wallet before signing; no transaction is sent.
9. Change wallet account between scan and signing; transaction is discarded and scan restarts.
10. Close an account externally after scan; revalidation detects it.
11. Simulate RPC timeout/rate limit; UI offers retry without duplicating transactions.
12. Test 24 accounts as 3 sequential transactions and verify all are confirmed and verified before the next batch is prepared.
13. Test 25+ accounts and verify processing continues sequentially without a fixed run cap.
14. Test a six-batch run; verify every batch receives a fresh review and wallet signature and no batch starts before the prior batch is confirmed and closed.
15. Delay user approval until the preview blockhash expires; verify account revalidation and a new blockhash happen after approval and before Phantom opens.
16. Make the confirmation waiter expire after submission while the signature is already finalized; verify the transaction is treated as confirmed and reconciliation continues.
17. Reload with pending batch records; after wallet connection, automatically verify the signature, transaction metadata, all account closures, Treasury credit, network fee, and wallet net before clearing records.
18. Keep records blocked when signature history or transaction metadata is unavailable; never infer failure from an expired blockhash or RPC timeout.
19. Verify recoverable transaction states use neutral informational styling, while actual execution failures remain distinguishable.

## 5. Manual wallet tests
- Phantom desktop, Devnet.
- Phantom mobile/browser handoff if mobile is in release scope.
- Wallet rejection.
- Wallet timeout.
- Account change.
- Network change.
- Wallet disconnect during scan.
- Wallet disconnect while waiting for confirmation.
- Transaction preview clearly shows close instructions and treasury transfer.
- Optional `signAllTransactions` is not assumed to exist.

## 6. Mainnet release tests
- Read-only scans on representative wallets.
- Dedicated low-value test wallet.
- Confirm real lamports reclaimed match account balances.
- Confirm fee transfer is exactly 15% with floor rounding.
- Confirm actual network fee matches transaction metadata.
- Confirm no priority fee is included by default.
- Confirm one-account recovery works when wallet has enough spendable SOL for network fee.
- Confirm insufficient network-fee balance is explained and does not prompt a doomed transaction.

## 7. Load and scale tests
- Scan wallets with 10, 100, 1,000, and 3,000 token accounts using RPC fixtures/mocks first.
- Measure RPC request count, latency, memory, and UI responsiveness.
- Do not send thousands of live transactions as a load test.
- Test batch creation and UI rendering independently from transaction submission.
- Confirm a 3,000-account scan cannot cause unbounded concurrency or memory growth.

## 8. Definition of done
- All unit tests pass.
- Integration tests pass on Devnet.
- E2E tests pass for the supported wallet path.
- Lint, typecheck, and production build pass.
- Security checklist in `docs/SECURITY.md` is complete.
- No known critical/high security issue remains.
- Owner reviews the Mainnet release checklist and explicitly approves deployment.