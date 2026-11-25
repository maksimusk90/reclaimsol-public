# Security — ReclaimSOL

## 1. Security objectives
- User controls all wallet signatures.
- Reclaimed SOL goes only to the connected wallet.
- Service fee goes only to the configured treasury.
- Non-zero token balances are burned only through an explicit, irreversible, per-selection consent flow; no token transfer to another wallet is performed.
- Unsupported account types fail closed.
- The official client validates the configured treasury and fee rate before building a transaction; client-side fee collection is not tamper-proof or protocol-enforced.
- A stale scan cannot authorize an unsafe close.

## 2. Threat model

### Assets
- User SOL balances and token accounts.
- User wallet authority/signing capability.
- Service treasury address and fee configuration.
- Transaction integrity and recovery calculations.
- User privacy (wallet address and scan results).

### Threat actors / failure sources
- Malicious or compromised frontend dependency.
- Malicious RPC response or RPC outage.
- Client-side request tampering.
- Wallet adapter mismatch or malicious wallet.
- Stale account state / race condition.
- Incorrect Token-2022 extension handling.
- Incorrect fee arithmetic.
- Replay/duplicate submission.
- Phishing or counterfeit ReclaimSOL frontend.
- Compromised deployment environment.

## 3. Key controls

### Wallet and key handling
- Never ask for a seed phrase, private key, JSON keypair, or wallet export.
- Never implement backend wallet signing in MVP.
- Use wallet adapter APIs only.
- Clear wallet-specific UI state on disconnect/account change.
- Do not persist private wallet state.

### Destination controls
- For every close instruction, assert destination equals connected wallet public key.
- For service fee transfer, assert destination equals validated treasury configuration.
- The official client loads the treasury from public build-time configuration, validates it, and does not accept a user-supplied treasury field. This protects the normal official-client flow, not a hostile modified client: a modified client can change or omit the transfer, so the 15% service fee is not protocol-enforced.
- Before wallet prompt, decode/inspect the final transaction and verify all instructions are expected.
- If transaction contains an unknown instruction, stop and do not request signature.

### Account validation
- Fetch current account data immediately before building each transaction.
- Validate account owner program ID.
- For empty-account closure, validate token amount equals zero. For Burn + Close, require explicit consent and validate the full spendable amount and mint decimals immediately before preparation.
- Validate connected wallet is authorized to close.
- Validate extension/state support.
- Never infer safety from token price, symbol, logo, metadata, or liquidity.
- Exclude unknown Token-2022 extensions.
- Do not close wrapped SOL/native token accounts through generic flow.
- Do not close program-owned PDA accounts or special protocol accounts in MVP.

### Transaction safety
- Simulate exact transaction before signing.
- Use a fresh recent blockhash and appropriate last-valid-block-height handling. Do not start the signing blockhash lifetime before the user review; re-read the selected accounts after approval and fetch the signing blockhash immediately before opening the wallet.
- Verify transaction message instructions before asking for signature.
- Use one transaction at a time.
- Do not automatically retry a signed transaction with a different message.
- If status is ambiguous, query signature status and chain state before retrying.
- Treat confirmation timeout or block-height expiry as a reason to inspect the signature history; if the transaction is already confirmed/finalized, continue reconciliation rather than reporting an unknown outcome.
- Keep local pending records until transaction metadata, Treasury/wallet balance deltas, and every affected account are verified. Automatically recheck them when the wallet reconnects.
- Remember that network fees can be charged even when transaction execution fails.
- Enforce account count and transaction-size limits.
- No priority fee by default.
- No hidden tip or additional transfer.

### Fee calculation
- All values in integer lamports.
- Service fee: floor(gross reclaimed lamports * 1500 / 10000).
- No minimum and no maximum.
- Apply fee only to accounts closed successfully within the atomic transaction.
- If a transaction fails, no state changes or treasury transfer should commit, but network fee may still be charged.
- The connected wallet is fee payer in MVP and must have spendable SOL before execution to satisfy fee-payer validation.
- Display service fee and estimated network fee separately.
- Verify actual fee from transaction metadata after confirmation when available.

## 4. Atomic fee collection design
Within one transaction:
1. If a selected Token-2022 account has acknowledged withheld fees, harvest those fees to the mint.
2. If a selected account has a non-zero spendable token balance, require explicit irreversible consent and burn the full balance with `BurnChecked`.
3. Close each supported token account, sending its lamports to the connected wallet.
4. Transfer 15% of the gross reclaimed lamports to the configured treasury.
5. User signs the transaction as owner/close authority and fee payer.

All instructions are atomic with respect to account state. If one instruction fails, state changes revert, so the treasury transfer must not commit. The network transaction fee can still be charged. The official client constructs the 15% transfer; it is not enforced by the Token Program or a ReclaimSOL on-chain program and can be omitted by a modified client.

Before release, integration tests must prove:
- treasury receives exact fee on success;
- treasury receives nothing on failed execution;
- user receives gross less fee on success;
- no unrelated account receives lamports;
- wallet is fee payer and signer;
- fee payer balance is checked before execution.

## 5. RPC and dependency controls
- Validate all RPC-returned data before use.
- Use TLS endpoints.
- Keep RPC provider credentials server-side if they are secret; if browser access is required, use provider restrictions and quotas.
- Pin dependencies and audit dependency changes.
- Avoid unmaintained packages.
- Do not use arbitrary transaction deserialization/serialization without validation.
- Rate-limit public API routes.
- Avoid exposing detailed stack traces to end users.

## 6. Privacy
- No registration in MVP.
- No database of wallet scans.
- Avoid storing wallet addresses in logs.
- No tracking pixels or analytics that transmit wallet identity by default.
- Disclose that Solana transactions and addresses are public on-chain.
- Retain only operational data strictly necessary for service reliability.

## 7. Operational security
- Separate Devnet and Mainnet configuration.
- Require an explicit network value and verify RPC `getGenesisHash` against the expected cluster before any scan or transaction preparation.
- Derive RPC, scanner, pending namespace, Explorer URL, and UI label from one validated network config.
- Never infer cluster identity from a custom RPC URL hostname.
- Validate treasury address on startup.
- Protect production environment variables.
- Restrict VPS SSH and admin access.
- Use HTTPS.
- Keep backups of deployment configuration, not secrets in source control.
- Document rollback and incident response.
- Do not deploy Mainnet changes without owner approval.

## 8. Release security checklist

The checklist below is a release-gate template, not a claim that every item has been completed. Independent security review and full wallet/transaction end-to-end coverage have not been represented as completed in this repository.
- [ ] No seed phrase/private-key collection code.
- [ ] No backend signing key.
- [ ] Treasury address is fixed and validated.
- [ ] Close destinations are connected wallet.
- [ ] Non-zero token accounts require explicit, irreversible full-balance burn consent; missing or withdrawn consent blocks preparation.
- [ ] Unknown extensions excluded.
- [ ] Exact transaction inspected before signing.
- [ ] Simulation required.
- [ ] Fee calculations use integer lamports.
- [ ] No priority fee by default.
- [ ] Failed transactions do not count as recovered.
- [ ] Duplicate submission handling tested.
- [ ] Mainnet tested with dedicated low-value wallet.
- [ ] Security review completed.