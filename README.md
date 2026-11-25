# ReclaimSOL

ReclaimSOL is a non-custodial Solana web application for discovering supported token accounts and reclaiming the SOL rent held by eligible accounts. The user connects a wallet and signs every transaction personally.

- Website: https://reclaimsol.solarchitect.xyz/
- Public source snapshot: https://github.com/maksimusk90/reclaimsol-public
- Network: the hosted production application currently uses Solana Mainnet; local development defaults to Devnet.

## What it does

- Scans token accounts owned by the connected wallet under the SPL Token Program and supported Token-2022 configurations.
- Identifies eligible empty accounts that may be closed and their rent reclaimed.
- Supports a separately consented, irreversible full-spendable-balance Burn + Close path for supported non-zero accounts.
- Processes selected accounts in sequential batches, with a maximum of 8 token accounts per transaction. Each transaction requires a separate wallet signature and post-transaction verification.
- Shows gross recovered rent, service fee, estimated network fee, and estimated net recovery before signing.

## Custody and transaction model

ReclaimSOL does not ask for seed phrases or private keys and does not sign transactions on behalf of users. The connected wallet authorizes and signs transactions. The service does not custody user funds.

The service fee is 15% of gross rent actually reclaimed, with no minimum or maximum. Network fees are separate and paid by the user; priority fee is zero by default. The official client constructs a treasury transfer in the same transaction. **This fee is client-side and is not enforced by an on-chain ReclaimSOL program. A modified client can omit or alter it.** Users should inspect recipients and amounts in their wallet before signing.

Token-2022 support is limited to explicitly allowlisted and handled account extensions; this is not support for every possible extension combination. Withheld transfer fees are handled according to the documented mint-harvest flow and are not represented as SOL returned to the user's wallet. Token metadata, logos, symbols, and names are not used to infer market value or determine that an asset is worthless.

## Development

Requirements: Node.js `>=24.15.0` and npm.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

The template defaults to Devnet. Configure the appropriate public network settings for local testing. Never place private provider credentials in `NEXT_PUBLIC_*` variables or commit real `.env` files. Production secrets and Mainnet RPC credentials are managed outside this repository.

Useful checks:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Documentation

- [Product and technical specification](SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security model and limitations](docs/SECURITY.md)
- [Mainnet release and incident runbook](docs/MAINNET_RELEASE_RUNBOOK.md)
- [Testing notes](docs/TESTING.md)

The release runbook contains explicit gates that are not all marked complete. This repository does not claim an independent security audit or complete end-to-end validation of every wallet, Token-2022 extension, and transaction lifecycle.

## License and source availability

**All rights reserved.** This repository is published for source-code inspection and transparency only. No license is granted to use, copy, modify, distribute, sublicense, or create derivative works from this code. All rights remain with the copyright holder. If you need permission for a particular use, obtain written authorization first.

This notice is not a substitute for legal advice.
