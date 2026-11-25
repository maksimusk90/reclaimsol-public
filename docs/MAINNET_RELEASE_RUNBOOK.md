# Mainnet Release Runbook — ReclaimSOL

Status: **Mainnet transaction mode is owner-authorized for controlled testing.** Wallet signatures remain required; the service never holds private keys or signs on behalf of users.

## 1. Release and safety gates

- [ ] Latest hardening PR merged after code review and green CI.
- [ ] Independent security review / penetration test completed; findings triaged.
- [ ] Phantom E2E completed for successful signing, rejection, disconnect, account change, and network change.
- [ ] Burn + Close E2E completed for SPL Token and Token-2022 with explicit irreversible-burn consent; test withheld-fee harvest separately.
- [ ] Batch lifecycle E2E completed with sequential batches, cancellation, partial completion, and ambiguous RPC outcomes.
- [ ] Delayed user approval tested: after approval, accounts are re-read and a new blockhash is fetched immediately before Phantom signing.
- [ ] Confirmation-wait expiry tested: query the signature and continue reconciliation if it is already confirmed/finalized.
- [ ] Pending records are automatically rechecked on wallet reconnect; they clear only after transaction metadata, Treasury/wallet deltas, and every affected account are verified.
- [ ] Mainnet scan verified against the expected Mainnet genesis hash.
- [ ] Treasury address and 15% client-side fee disclosure independently checked.
- [ ] Monitoring, rollback, incident response, and support ownership assigned.
- [ ] Before each transaction, the connected wallet owner reviews and signs the exact transaction.

## 2. Network and RPC configuration

The application accepts only explicit `devnet` or `mainnet-beta` configuration. It verifies the RPC's `getGenesisHash` result before scanning and before each batch preparation/signing flow.

Mainnet is checked strictly against `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`. Any other hash fails closed.

Production RPC requirements:
- `NEXT_PUBLIC_SOLANA_RPC_URL` is delivered to browser code. **Never put a secret API key in this variable.**
- Mainnet builds are pinned to the same-origin `/api/solana/rpc` server route. It reads `HELIUS_MAINNET_RPC_URL` and optional `HELIUS_MAINNET_RPC_FALLBACK_URL` from server-only environment variables, and accepts only `https://mainnet.helius-rpc.com` endpoints.
- The proxy permits a bounded JSON-RPC method allowlist, including `sendTransaction` for wallet-signed transactions. It does not hold keys or sign transactions.
- The proxy rejects cross-origin requests, limits request size and batches, and applies a per-process request cap.
- The fallback is attempted only after transient network failures and upstream HTTP 5xx responses. HTTP 429 and provider quota/authentication errors are returned without switching accounts. Do not pool free-account quotas or bypass Helius plan limits.
- Keep Devnet and Mainnet deployment configurations separate. Never change the live network by editing an unrelated Devnet environment in place.

## 3. Treasury and fee verification

- Verify the treasury public key independently from the release configuration.
- Verify the configured fee basis points equal the approved 15%.
- Verify the exact batch review displays gross rent, service fee, estimated network fee, estimated net, fee-payer balance, and treasury address before every wallet prompt.
- The official client constructs the 15% transfer. It is not enforced by the Token Program or a ReclaimSOL on-chain program; a modified client can omit it.
- Reconcile confirmed transaction metadata against account lamport debits, treasury credit, actual network fee, and wallet net.
- Do not let the review dialog consume the signing transaction's blockhash lifetime: re-read the batch after user approval and fetch the signing blockhash as the final RPC step before opening Phantom.
- Network costs are paid separately at actual cost; priority fee is zero by default.

## 4. Controlled first Mainnet transaction

1. Use a dedicated test wallet, not a treasury or primary wallet.
2. Start with one empty token account with negligible asset value. Do not start with non-zero balances or Burn + Close.
3. Review the prepared transaction and wallet preview. Verify the fee payer, account, treasury address, gross rent, 15% service fee, estimated network fee, and net amount.
4. Confirm only if the wallet preview matches the app review.
5. Independently inspect transaction metadata, account closure, treasury credit, actual network fee, and wallet balance delta.
6. Stop immediately if any amount, destination, account state, or fee differs from the preview.
7. Only after a successful smoke test consider a small multi-account batch. Maximum 8 token accounts per transaction.
8. Non-zero token balances require explicit irreversible-burn consent and are not part of the initial empty-account smoke test.

## 5. Monitoring and incident response

Track RPC latency, 429/403 responses, timeouts, transaction-history availability, scan failures, unsupported-account classifications, prepared/signed/submitted/confirmed/failed/unresolved batches, actual network fees, gross rent, service-fee transfers, and net wallet deltas.

If RPC metadata is unavailable or inconsistent:
1. Stop the current run; do not retry the batch.
2. Keep the pending record.
3. Recheck signature status with transaction-history search. An expired confirmation waiter or blockhash is not proof that the transaction failed.
4. If the signature is confirmed/finalized, reconcile transaction metadata, every affected account, Treasury credit, actual network fee, and wallet net.
5. If status remains unknown or metadata is unavailable, preserve the record and retry verification later; never clear it based only on an Explorer page or a missing RPC response.
6. Resume only after the record is safely resolved.

If the frontend behaves unexpectedly, disable access to the affected Mainnet deployment, preserve the last known-good artifact, keep Devnet untouched, and reconcile all affected signatures before restoring service. A frontend maintenance switch cannot prevent a user from constructing a transaction independently on Solana.

## 6. Release record

For every release, record source commit and PR, CI result, build artifact, network and genesis hash, RPC provider identifier (never the secret key), treasury and fee basis points, E2E evidence, approval record, and rollback artifact.