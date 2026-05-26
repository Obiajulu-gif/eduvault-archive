# trying again
devfoma

# EduVault

EduVault is an educational content marketplace that helps educators and student creators publish, license, and monetize learning materials using low-cost payment rails and verifiable ownership primitives on Stellar.

## Status

EduVault is an in-development project. This repository already contains a working Next.js prototype for creator profiles, content uploads, IPFS-backed metadata, and marketplace flows. It also preserves an archived EVM/Celo proof of concept for tokenized ownership under `archive/legacy-evm/`. The Drip Wave submission proposes the next milestone: moving payments, licensing, and entitlement checks onto Stellar and Soroban.

## Overview

Educational materials are routinely distributed through closed chat groups, informal marketplaces, and ad hoc file sharing. That makes pricing inconsistent, creator attribution weak, and access control difficult. EduVault addresses that gap with a creator-first distribution layer for notes, guides, templates, and exam prep materials. Files remain off-chain for efficiency, while payments, licensing state, and entitlement proofs are moved onto Stellar where they can be settled cheaply and verified openly.

## Problem Statement

- Educational creators often cannot monetize low-cost digital materials because card rails and payout infrastructure are too expensive for small transactions.
- Students and professionals have limited ways to verify that a resource came from the actual author or institution.
- Cross-border educational commerce is fragmented, especially in markets where local payment coverage is inconsistent.
- Existing content platforms usually optimize for media distribution, not rights-aware academic content access.

## Solution

EduVault combines off-chain file storage with on-chain payment and entitlement records:

- Learning materials are uploaded, pinned to IPFS, and indexed in a searchable catalog.
- Creators define usage rights, pricing, and visibility rules.
- Buyers pay in XLM or supported Stellar assets such as USDC on Stellar.
- Soroban contracts record purchase entitlements, payout rules, and access permissions.
- The application checks on-chain ownership or entitlement status before revealing protected download access.

## Why This Project Matters

EduVault targets a real commercial behavior that already exists: students and educators buying and sharing digital learning materials in low-ticket transactions. Stellar is well suited for this because the network is built for fast, low-cost payments and interoperable asset flows. That combination makes educational micropayments economically viable in a way that conventional rails often are not.

This matters beyond a single app. If EduVault succeeds, it becomes a reusable pattern for digital content licensing on Stellar: creator payments, entitlement gating, institution-issued access assets, scholarship credits, and cross-border educational commerce.

## Core Features

- Wallet-linked creator profiles
- Educational material upload flow with thumbnail support
- IPFS-backed file and metadata storage through Pinata
- MongoDB-backed catalog and profile persistence
- Marketplace discovery and item detail pages
- Usage-rights and pricing metadata for each material
- Planned Stellar-native checkout and access entitlement verification
- Planned creator payout and revenue-split logic on Soroban

## How It Works

1. A creator connects a wallet and creates a profile.
2. The creator uploads a document and optional cover image.
3. The backend pins the file and metadata to IPFS and stores searchable catalog state in MongoDB.
4. The listing is published with price, license terms, and creator attribution.
5. In the Stellar milestone, a Soroban contract registers the material, accepted payment asset, and license conditions.
6. A buyer completes payment in XLM or a supported Stellar asset.
7. The application verifies the entitlement on-chain and grants access to the purchased resource.

## Stellar Ecosystem Alignment

EduVault is strategically aligned with Stellar for four reasons:

- Stellar is optimized for fast, low-cost payment flows, which is critical for low-value digital educational purchases.
- Soroban allows entitlement, payout, and licensing rules to be enforced on-chain without moving the file contents themselves on-chain.
- Stellar Asset Contracts and classic Stellar assets make it practical to accept stable assets, creator-issued access tokens, or institution-issued credits.
- Stellar already has strong payment and stablecoin positioning, which makes it a better fit for educational commerce and financial access than a general-purpose NFT-only narrative.

Stellar documentation confirms that Soroban is integrated into the existing Stellar blockchain and that Stellar assets can be used directly from Soroban through the Stellar Asset Contract model. Official Stellar materials also position USDC on Stellar around fast, low-cost, global payments, which maps directly to the EduVault checkout and payout model.

## Specific Benefits To The Stellar Blockchain

- Increases utility on Stellar through recurring digital goods transactions instead of one-off speculative activity.
- Creates a practical creator economy use case for Stellar in education.
- Expands demand for XLM and Stellar-based stable assets as settlement rails for low-ticket commerce.
- Provides a reusable open-source reference for Soroban-based marketplaces, entitlement gating, and creator payouts.
- Supports financial inclusion by making it viable to sell and buy educational content across borders with minimal fees.
- Opens room for institution-issued assets such as scholarship credits, cohort passes, or verified course access rights.

## Why It Is Valuable

### For developers

- Offers a concrete marketplace pattern for combining Soroban contracts with off-chain storage and web application state.
- Can evolve into reusable modules for entitlement checks, asset-based licensing, and creator royalty distribution.
- Demonstrates a practical way to connect content access to Stellar account state.

### For users

- Reduces the cost of paying for educational materials.
- Improves attribution and trust around who published a resource.
- Makes cross-border purchase and payout flows more accessible.

### For the ecosystem

- Brings real transaction volume tied to learning, upskilling, and creator income.
- Broadens Stellar's presence in digital commerce beyond remittance and treasury use cases.
- Gives ecosystem partners a credible application layer example for education and financial access.

## Technical Architecture

### Current repository state

- Frontend: Next.js App Router, React 19, Tailwind CSS 4
- Backend: Next.js route handlers for uploads, profiles, and material catalog operations
- Storage: MongoDB for profiles and catalog metadata
- File persistence: IPFS pinning through Pinata
- Wallet prototype: wagmi, RainbowKit, WalletConnect, and Coinbase Wallet support
- Smart contract prototype: archived Solidity ERC-721 proof of concept in [`archive/legacy-evm/contracts/EduVault.sol`](archive/legacy-evm/contracts/EduVault.sol)

### Proposed Stellar-native architecture

- Frontend application for creator onboarding, browsing, purchase flow, and access checks
- Backend API for metadata management, entitlement-aware file delivery, email notifications, and indexing support
- Soroban contracts for material registration, payment handling, revenue distribution, and purchase entitlements
- Stellar RPC/Horizon-based indexing service for syncing on-chain state to the application catalog
- IPFS or managed object storage for file bytes and previews, with on-chain references to immutable metadata

## Proposed Tech Stack

### Current

- Next.js 16
- React 19
- Tailwind CSS 4
- MongoDB
- Pinata/IPFS
- Nodemailer
- wagmi and RainbowKit
- OpenZeppelin contracts

### Planned Stellar additions

- Soroban smart contracts written in Rust
- Stellar SDK and RPC/Horizon clients for transaction submission and indexing
- Stellar wallet integration for account-based auth and signing
- XLM and Stellar-based stable assets for settlement
- Optional issuer/distribution account tooling for creator or institution-issued assets

## Smart Contract / Blockchain Interaction

### Current prototype

This repository preserves an archived ERC-721 contract and EVM wallet integration used to validate the upload-to-ownership flow during early prototyping. That contract is not the final blockchain strategy for the Drip Wave submission and should not be extended for new product work.

## Legacy EVM Prototype

The Solidity/Celo prototype is archived under `archive/legacy-evm/`.

- It is retained for historical reference and tests only.
- It must not be treated as the production chain layer.
- New product work should target Stellar and Soroban instead.

## Migration Checklist

- Replace wallet-specific EVM assumptions in the UI with Stellar wallet flows.
- Implement Soroban material registration and entitlement checks.
- Replace legacy purchase/mint UI with Soroban-backed publishing and checkout.
- Remove any production environment assumptions that reference Celo or the archived contract.
- Keep legacy prototype tests isolated under archived contract checks only.

### Proposed Stellar implementation

The proposed Stellar design is intentionally practical:

- `MaterialRegistry` contract
  - Registers a material ID, creator address, metadata hash, price, accepted asset, and rights hash.
- `PurchaseManager` contract
  - Accepts payment in XLM or approved Stellar assets, records entitlement state, and emits purchase events.
- `PayoutConfig` logic
  - Supports creator payouts, treasury fees, and later scholarship or referral splits.

Content files stay off-chain. The chain is used for settlement, rights registration, and access verification.

## Installation

Examples below use `npm`, but `pnpm` or `bun` can also be used.

### Prerequisites

- Node.js 20+
- npm 10+ or pnpm
- MongoDB 7+ or Docker
- Pinata credentials for file uploads
- A wallet for testing current prototype flows

### Setup

```bash
git clone https://github.com/Obiajulu-gif/eduvault.git
cd eduvault
npm install
cp .env.example .env.local
```

If you want a local MongoDB instance:

```bash
docker compose up -d mongodb
```

Start the app:

```bash
npm run dev
```

Open `http://localhost:3000`.

### Test workflows

Run the Solidity prototype tests:

```bash
npm run test:contracts
```

Run backend validation, rate-limit, and indexer tests:

```bash
npm run test:backend
```

Run the full local test baseline:

```bash
npm test
```

Backend schema and route contracts are documented in [`docs/backend-contracts.md`](docs/backend-contracts.md).

## Local Development Setup

1. Install dependencies.
2. Copy `.env.example` to `.env.local`.
3. Configure MongoDB, Pinata, and email credentials.
4. Run `docker compose up -d mongodb` if you do not already have MongoDB running.
5. Start the development server with `npm run dev`.

## Environment Variables

See [`.env.example`](.env.example) for the canonical template.

| Variable | Required | Purpose |
| --- | --- | --- |
| `MONGODB_URI` | Yes | MongoDB connection string |
| `MONGODB_DB` | No | MongoDB database name, defaults to `eduvault` |
| `JWT_SECRET` | Yes | Signs session cookies for authenticated routes |
| `NEXT_PUBLIC_APP_URL` | Yes | Public base URL used in links and emails |
| `PINATA_JWT` | Yes | Pinata authentication for uploads |
| `NEXT_PUBLIC_GATEWAY_URL` | Yes | Gateway URL used to resolve pinned content |
| `EMAIL_USER` / `EMAIL_PASS` | Optional | Simple email transport configuration |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Optional | Explicit SMTP configuration |
| `EMAIL_FROM` | Optional | Override sender address |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Optional | Enables current wallet prototype |
| `NEXT_PUBLIC_STELLAR_NETWORK` | Planned | Target Stellar network for Soroban milestone |
| `NEXT_PUBLIC_STELLAR_RPC_URL` | Planned | Soroban RPC endpoint |
| `NEXT_PUBLIC_HORIZON_URL` | Planned | Horizon endpoint for indexing and account lookups |
| `NEXT_PUBLIC_SOROBAN_CONTRACT_ID` | Planned | Contract ID for entitlement and payment logic |
| `NEXT_PUBLIC_ACCEPTED_ASSET` | Planned | Default accepted payment asset such as `XLM` or `USDC` |

## Deployment Guardrails

- Production builds and startups validate required environment values before the app serves traffic.
- Placeholder secrets such as `replace-with-a-long-random-string` fail validation in production.
- CI runs dependency audits and a secret/placeholder scan before merge.
- Security headers are set centrally in `next.config.mjs` for all application routes.
- Dashboard middleware verifies the signed session token before protected routes render.

### Production vs Local Environment

- Local development may leave some Soroban settings unset while the feature is still gated.
- Production deployments must provide real `JWT_SECRET`, `MONGODB_URI`, `PINATA_JWT`, `NEXT_PUBLIC_APP_URL`, and `NEXT_PUBLIC_GATEWAY_URL` values.
- Once Soroban features are enabled, production must also provide valid `NEXT_PUBLIC_STELLAR_RPC_URL`, `NEXT_PUBLIC_HORIZON_URL`, and `NEXT_PUBLIC_SOROBAN_CONTRACT_ID`.
- Preview and production environments should not use placeholder values for any credential-like setting.

## Usage

### Current prototype flow

1. Visit the landing page and connect a wallet.
2. Create a profile through the wallet onboarding flow.
3. Upload a document from the dashboard.
4. Browse materials in the marketplace.
5. Review listing details and purchase flow prototypes.

### Planned Stellar flow

1. Creator registers a material and pricing terms.
2. Buyer pays with XLM or a supported Stellar asset.
3. Soroban records entitlement state.
4. EduVault verifies entitlement before releasing protected content access.

## Roadmap

### Near term

- Finalize README, contribution docs, and maintainership materials
- Clean up prototype flows and remove stale chain-specific UI references
- Model the Soroban contract interfaces for registry and entitlement logic

### Next milestone

- Add Stellar wallet support and account-based auth
- Deploy Soroban contracts to Stellar testnet
- Support XLM and USDC-based checkout
- Gate downloads based on on-chain entitlement state
- Add creator payout accounting

### Later

- Institution-issued access assets and scholarship credits
- Bulk licensing for schools and learning communities
- Analytics for creators and cohort-based access controls
- Optional fiat on/off-ramp integrations through Stellar ecosystem partners

## Future Improvements

- Reputation and verification for educators and institutions
- Secondary license transfers where policy allows
- Referral payouts and affiliate tracking
- Credential issuance for verified learning outcomes
- Mobile-first purchase flow for low-bandwidth environments
- Moderation and dispute tooling for marketplace integrity

## Contribution Guidelines

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. High-signal contributions include:

- Product and architecture feedback tied to educational commerce on Stellar
- Soroban contract design improvements
- Security reviews for entitlement and payout logic
- Developer experience improvements for local setup and testing
- Documentation updates that improve technical clarity

## License

This project is licensed under the [MIT License](LICENSE).

## Maintainer

Maintained by [Obiajulu-gif](https://github.com/Obiajulu-gif).

For roadmap discussion, architecture questions, or ecosystem collaboration, open an issue or discussion in this repository.
