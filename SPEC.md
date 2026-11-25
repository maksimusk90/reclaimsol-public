# SPEC.md — ReclaimSOL MVP Product & Technical Specification

**Status:** Approved baseline for implementation planning  
**Product:** ReclaimSOL  
**Repository:** `reclaimsol`  
**Release target:** MVP  
**Network target:** Solana Mainnet, developed and tested on Devnet first  
**Product type:** Public, non-custodial web application

## 1. Product summary

ReclaimSOL helps a user connect a Solana wallet, scan supported SPL Token and Token-2022 accounts, review recoverable lamports and costs, select accounts, and sign recovery transactions in their own wallet. Empty accounts may be closed directly. Non-zero token accounts may be processed only after explicit consent to irreversibly burn their full spendable token balance before closing.

The MVP supports token accounts owned by the connected wallet under:
- SPL Token Program
- Token-2022 Program, only for account configurations explicitly supported and tested

Empty accounts may be closed directly. Non-zero accounts require the separately consented full-balance Burn + Close flow.

Pump.fun- and PumpSwap-specific auxiliary accounts are out of MVP scope. The architecture must allow future program-specific scanners, but must not claim support until each account type and its close/reclaim instruction is researched and tested against authoritative program sources.

## 2. Product goals

- Make reclaimable SOL discoverable without requiring user registration.
- Give the user a transparent estimate before signing.
- Support individual and batch recovery.
- Charge a transparent 15% service fee on successfully reclaimed gross lamports.
- Keep the user in control of signing and destination.
- Avoid accidental destruction of token balances or closure of accounts with unsupported state.
- Work reliably with mainstream Solana wallets, beginning with Phantom through Solana Wallet Adapter.

## 3. Non-goals for MVP

- Custody, seed phrase collection, private-key storage, or backend signing.
- Automatic/background cleanup.
- Price-based judgement that a token is worthless.
- Pump.fun/PumpSwap special-account recovery.
- Telegram bot or Telegram Mini App.
- User accounts, subscriptions, referral system, CRM, or persistent transaction history.
- Sponsored transactions / relayer-paid fees.
- Multi-wallet portfolio management.
- NFT classification as a basis for automatic deletion.
- Guaranteed recovery of every lamport in every wallet.

## 4. Supported user journey

1. User opens ReclaimSOL.
2. User connects a supported Solana wallet.
3. App uses one validated network configuration for RPC, scanner, pending records, UI labels, and Explorer links. Before scanning or transaction preparation, it verifies the RPC genesis hash against the selected cluster. The current production deployment runs on Solana Mainnet. Devnet remains available for development and isolated testing. Production network and RPC values are managed in the protected deployment environment.
4. User starts a scan.
5. App fetches token accounts under both supported token program IDs.
6. App classifies each account and calculates an estimate using actual account lamports and eligibility checks.
7. User reviews eligible accounts and excluded accounts.
8. User selects one or more eligible accounts.
9. App displays gross recovery, service fee, estimated network fee, and estimated net recovery.
10. App re-fetches/revalidates selected accounts.
11. App builds and simulates a transaction.
12. User reviews and signs in their wallet.
13. App submits the signed transaction and waits for confirmation.
14. App verifies closure and actual lamport movement.
15. UI displays the result and continues with the next batch if applicable.

## 5. Account eligibility rules

### 5.1 Supported scan scope
- Query all token accounts owned by the connected wallet for the canonical SPL Token Program.
- Query all token accounts owned by the connected wallet for the canonical Token-2022 Program.
- Do not restrict the scan to Associated Token Accounts only.
- Use RPC account owner/program ID and parsed account data; do not infer account type from mint metadata.

### 5.2 Eligible account baseline
An empty account may be marked `Reclaimable` only when all of the following are true:
- The account exists at the time of the latest validation.
- The account is owned by one of the supported token programs.
- Its decoded token amount is exactly zero for the direct empty-account path.
- The connected wallet is the account owner or the explicitly configured close authority and can sign the required instruction.
- The account's token-program state and extensions are understood and supported by the implementation.
- The close instruction can be built with the connected wallet as signer.
- The destination for reclaimed lamports is exactly the connected wallet public key.

Frozen zero-balance accounts may be closable according to the base Token Program documentation, but should remain `ReviewRequired` in the initial MVP unless dedicated integration tests prove the exact path for each supported program/version. Do not assume all Token-2022 extension combinations have identical close rules.

### 5.3 Excluded account cases
- Non-zero token balance: `HasTokens` until the user separately consents to the full-balance burn path.
- Unsupported or unknown Token-2022 extension: `Unsupported`.
- Missing close authority / connected wallet cannot authorize: `Unauthorized`.
- Frozen or special state not yet covered by tests: `ReviewRequired`.
- Wrapped SOL/native token accounts: excluded from the generic empty-token-account flow in MVP.
- Account no longer exists: `AlreadyClosed`.
- RPC failure or incomplete decode: `ScanError` / `ReviewRequired`, never `Reclaimable`.

For a non-zero account, the Burn + Close path requires affirmative, irreversible consent for the exact selected account; the connected wallet must be the token owner (delegated or third-party burn authority is not accepted). Burn the entire spendable amount with `BurnChecked`, then close the account atomically. Withheld Token-2022 transfer fees, when explicitly acknowledged, are harvested to the mint before burning and closing; they are not returned to the wallet or treasury. Never infer that an asset is worthless from its metadata or market data.

## 6. Recovery economics

### 6.1 Service fee
- Service fee rate: 15%.
- No minimum service fee.
- No maximum service fee.
- Service fee applies only to gross lamports actually reclaimed from accounts successfully closed in a confirmed transaction.
- Failed or skipped accounts incur no service fee.
- Fee arithmetic must use integer lamports and deterministic rounding.

For a transaction batch:
`serviceFeeLamports = floor(grossRecoveredLamports * 1500 / 10000)`

The exact rounding policy is floor to the nearest whole lamport. Show the rate and calculated lamport amount before signing.

### 6.2 Network fee
- Network fee is separate from the 15% service fee.
- Default priority fee is zero. Do not add a priority fee silently.
- Estimate the transaction fee using the transaction message and current RPC fee estimation facilities where available.
- The current documented base fee is 5,000 lamports per transaction signature; actual fee depends on signature count and any configured priority fee.
- User is the fee payer in MVP.
- The UI must show estimated network cost separately and, after confirmation, the actual network fee from transaction metadata where available.
- Network fees may be charged even if a transaction fails.
- Do not hardcode 5,000 lamports as the guaranteed total fee for every transaction; it is the current base fee per signature, not necessarily the complete transaction cost.

### 6.3 Example
If gross recovery is 1,460,000 lamports:
- Service fee at 15%: 219,000 lamports.
- Base network fee for one transaction with one signature and no priority fee: 5,000 lamports.
- Estimated net to user before any other applicable network costs: 1,236,000 lamports.

This is an illustrative calculation, not a promise that every account contains 1,460,000 lamports.

### 6.4 Economic guard
Before signing, calculate:
`estimatedNetLamports = grossRecoveryLamports - serviceFeeLamports - estimatedNetworkFeeLamports`

If estimated net is zero or negative, disable recovery and explain why. Do not impose a minimum service fee. Do not silently waive the 15% fee for selected accounts or per-batch subgroups.

### 6.5 Collection method
Preferred MVP design:
- Each `CloseAccount` instruction sends the closed account's lamports to the connected wallet.
- A subsequent System Program transfer in the same transaction sends the calculated service fee from the connected wallet to the configured treasury address.
- The transaction must be atomic: if any instruction fails, state changes revert, and no service fee transfer is committed. The network fee can still be charged.
- Treasury address and fee rate are public build-time client configuration, validated before transaction construction and never accepted from a user-supplied transaction request.
- The official ReclaimSOL client adds the 15% treasury transfer to the transaction. This is a client-constructed service fee, not protocol-enforced and not impossible to bypass with a modified client. Do not describe it as trustless or enforced by the Token Program.
- The user must be able to inspect the treasury transfer in the wallet's transaction preview where wallet UI supports it.

This design requires the connected wallet to be fee payer and signer, and requires enough pre-existing spendable SOL to pay the network fee before execution begins. The rent being reclaimed inside the transaction must not be treated as available to satisfy the runtime's pre-execution fee-payer balance check. If the wallet cannot pay the network fee upfront, show a clear insufficient-balance message. Sponsored transactions are out of MVP.

## 7. Batch processing rules

Owner decision after further Devnet testing:
- Maximum 8 token accounts per transaction. This is a conservative product safety ceiling, not a Solana protocol limit.
- No fixed maximum number of transactions or accounts per recovery run. The owner tested a six-batch run successfully; the application must not stop merely because three batches have completed.

Rules:
- Process transactions sequentially, not concurrently.
- Wait for confirmation and post-confirmation verification of every account before preparing the next transaction.
- Re-read and revalidate each batch immediately before preparing it, with a fresh blockhash and simulation.
- Show the exact prepared batch economics and require a separate in-app approval before opening the wallet for that batch.
- Every transaction still requires its own wallet signature.
- The user may cancel the remaining run at any point.
- If a transaction fails or its outcome is ambiguous, stop; do not count its accounts as recovered and do not automatically retry.
- Re-scan/revalidate before any retry.
- Enforce the 8-account transaction ceiling in the planner, preparation function, and prepared-transaction validator.

Possible future experiments, not MVP defaults:
- Feature-detected `signAllTransactions` where supported by the connected wallet.
- Solana transaction v1 format, after SDK, RPC, wallet, explorer, and hardware-wallet compatibility testing.
- Larger batch sizes after measured success.

Do not claim that `signAllTransactions` or transaction v1 bypasses wallet confirmation limits. Wallet APIs may be optional and wallet-specific.

## 8. User-facing batch explanation

Suggested copy:
"To keep transaction size and execution predictable, ReclaimSOL processes no more than 8 token accounts in one transaction. Larger selections are handled as sequential transactions. Each batch is reviewed and signed separately; the next batch is prepared only after the previous one is confirmed and all included accounts are verified closed."

Do not say "Solana only allows 8 accounts" or "the blockchain limit is 24"; both would be inaccurate.

## 9. UI requirements

### Landing page `/`
- Product name and concise value proposition.
- Primary CTA: Connect Wallet / Open App.
- Plain-language explanation of 15% service fee.
- Explain that network fees are separate and paid by the user.
- Explain non-custodial signing and that no seed phrase is requested.
- Explain that empty accounts can be closed directly and non-zero accounts require explicit irreversible burn consent.
- No fabricated recovery statistics or testimonials.

### App `/app`
- Wallet connection status and shortened public key.
- Network indicator.
- Scan button and scan progress.
- Summary: accounts scanned, eligible accounts, excluded accounts, estimated gross recovery.
- Account list with selection.
- Account address (shortened with copy action), token program, balance/status, lamports recoverable.
- Clear excluded-account reason.
- Select all eligible / deselect all.
- Recovery summary: gross recovery, 15% fee, estimated network fee, estimated net.
- Explicit transaction review before wallet prompt.
- Transaction progress and confirmed/failed states.
- Batch progress and explicit review before each wallet signature; user can cancel the remaining batches.
- Final report with signatures/explorer links.

### Legal pages
- `/terms`
- `/privacy`

Legal text must be reviewed for the operating jurisdiction and actual business model before public launch. Do not invent company identity, legal address, or regulatory claims.

## 10. Privacy and persistence
- No account registration required.
- No database required for MVP.
- Do not persist wallet addresses or scan results server-side.
- Keep scan data in client memory/session only.
- Error logs must redact wallet addresses and transaction payloads unless specifically required for debugging and explicitly approved.
- Public transaction signatures are on-chain; disclose that on-chain activity is public.

## 11. Functional acceptance criteria
- Connect and disconnect supported wallet.
- Require explicit `devnet` or `mainnet-beta` configuration and verify the connected RPC genesis hash before scanning or transaction preparation.
- Scan both supported token programs.
- Decode all accounts without assuming ATA-only.
- Correctly classify zero and non-zero balances.
- Correctly exclude unknown extension cases.
- Calculate recovery from live lamports, not hardcoded rent constants.
- Calculate 15% fee in integer lamports with floor rounding.
- No minimum or maximum service fee.
- Show estimated network fee separately.
- Do not add priority fee by default.
- Enforce 8-account transaction batch default.
- Do not impose a fixed transaction-count or total-account cap per run; preserve sequential confirmation and verification.
- Revalidate selected accounts before transaction build.
- Simulate before wallet signing.
- Close destination must equal connected wallet.
- Treasury destination must equal the validated public build-configured address.
- Confirm transaction and verify account closure.
- Display actual outcome, including partial progress across separate transactions.
- Failed transaction does not count as recovery and does not transfer service fee.
- No private key or seed phrase handling anywhere in app/backend.

## 12. Official references
- Solana Close Token Account: https://solana.com/docs/tokens/basics/close-account
- Solana Token Extensions: https://solana.com/docs/tokens/extensions
- Solana Transactions: https://solana.com/docs/core/transactions
- Solana Transaction Fees: https://solana.com/docs/core/fees
- Solana Versioned Transactions: https://solana.com/docs/core/transactions/versioned-transactions
- Solana Wallet Adapter: https://github.com/anza-xyz/wallet-adapter
- Solana RPC `getGenesisHash`: https://solana.com/docs/rpc/http/getgenesishash
- Solana cluster `getGenesisHash` method and current Devnet example: https://solana.com/docs/rpc/http/getgenesishash
- Phantom Wallet Adapter implementation: https://github.com/anza-xyz/wallet-adapter/tree/master/packages/wallets/phantom
