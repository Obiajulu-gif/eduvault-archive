# EduVault

EduVault is an educational content marketplace that helps educators, students, and creators publish, license, sell, and manage access to learning materials.

The project combines a modern Next.js application with off-chain file storage, searchable marketplace data, and a planned Stellar/Soroban payment and entitlement layer for low-cost educational content transactions.

## Overview

Many educational resources are shared through informal channels such as WhatsApp groups, Telegram communities, and manual file transfers. This makes it difficult for creators to earn fairly, buyers to verify ownership, and institutions to manage trusted access.

EduVault provides a creator-first marketplace where learning materials can be uploaded, listed, discovered, purchased, and accessed securely.

## Core Features

- Creator profiles connected to wallet-based onboarding
- Educational material upload flow with thumbnail support
- IPFS-backed file and metadata storage through Pinata
- MongoDB-backed catalog and profile persistence
- Marketplace discovery and material detail pages
- Usage-rights and pricing metadata for each resource
- Planned Stellar-native checkout with XLM or supported Stellar assets
- Planned Soroban-based entitlement checks for protected downloads

## How It Works

1. A creator creates a profile and connects a wallet.
2. The creator uploads a learning material and optional cover image.
3. The file and metadata are pinned to IPFS.
4. The listing is stored in MongoDB and displayed in the marketplace.
5. A buyer discovers the resource and completes the checkout flow.
6. The app verifies access rights before allowing protected downloads.

## Tech Stack

### Current Stack

- Next.js 16
- React 19
- Tailwind CSS 4
- MongoDB
- Pinata/IPFS
- Nodemailer
- wagmi and RainbowKit
- Hardhat and OpenZeppelin for the archived EVM prototype

### Planned Stellar Additions

- Soroban smart contracts written in Rust
- Stellar SDK and RPC/Horizon clients
- Stellar wallet integration
- XLM and Stellar-based stable asset payments
- On-chain purchase entitlement records

## Architecture

```text
Creator / Buyer
      |
      v
Next.js Frontend
      |
      v
Next.js API Routes
      |---------------------> MongoDB
      |---------------------> Pinata / IPFS
      |---------------------> Email Service
      |
      v
Planned Stellar Layer
      |
      v
Soroban Contracts + Stellar RPC/Horizon
```

### Current Repository State

- Frontend: Next.js App Router, React, Tailwind CSS
- Backend: Next.js route handlers for uploads, profiles, and catalog operations
- Storage: MongoDB for profiles and marketplace metadata
- File persistence: IPFS pinning through Pinata
- Wallet prototype: wagmi, RainbowKit, WalletConnect, and Coinbase Wallet support
- Legacy contract: archived Solidity proof of concept in `archive/legacy-evm/`

## Legacy EVM Prototype

The repository includes an archived Solidity/Celo proof of concept under `archive/legacy-evm/`.

This legacy code is kept for historical reference and testing only. New blockchain work should target Stellar and Soroban.

## Getting Started

### Prerequisites

- Node.js 20+
- npm 10+ or pnpm
- MongoDB 7+ or Docker
- Pinata credentials for file uploads
- Wallet credentials for testing wallet-based flows

### Installation

```bash
git clone https://github.com/Obiajulu-gif/eduvault.git
cd eduvault
npm install
cp .env.example .env.local
```

Start MongoDB locally with Docker:

```bash
docker compose up -d mongodb
```

Start the development server:

```bash
npm run dev
```

Open the app at:

```text
http://localhost:3000
```

## Environment Variables

Use `.env.example` as the main reference for local configuration.

| Variable | Required | Purpose |
| --- | --- | --- |
| `MONGODB_URI` | Yes | MongoDB connection string |
| `MONGODB_DB` | No | MongoDB database name. Defaults to `eduvault` |
| `JWT_SECRET` | Yes | Signs session cookies for authenticated routes |
| `NEXT_PUBLIC_APP_URL` | Yes | Public app URL used in links and emails |
| `PINATA_JWT` | Yes | Pinata authentication for uploads |
| `NEXT_PUBLIC_GATEWAY_URL` | Yes | Gateway URL for pinned content |
| `EMAIL_USER` / `EMAIL_PASS` | Optional | Simple email transport configuration |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Optional | SMTP email configuration |
| `EMAIL_FROM` | Optional | Custom sender address |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Optional | Enables current wallet prototype |
| `NEXT_PUBLIC_STELLAR_NETWORK` | Planned | Target Stellar network |
| `NEXT_PUBLIC_STELLAR_RPC_URL` | Planned | Stellar/Soroban RPC endpoint |
| `NEXT_PUBLIC_HORIZON_URL` | Planned | Horizon endpoint for account and event indexing |
| `NEXT_PUBLIC_SOROBAN_CONTRACT_ID` | Planned | Contract ID for entitlement and payment logic |
| `NEXT_PUBLIC_ACCEPTED_ASSET` | Planned | Default accepted asset such as `XLM` or `USDC` |

## Available Scripts

```bash
npm run dev
npm run build
npm run start
npm run lint
npm test
npm run test:contracts
npm run test:backend
npm run audit:deps
npm run scan:secrets
```

## Testing

Run the full test suite:

```bash
npm test
```

Run backend tests:

```bash
npm run test:backend
```

Run archived Solidity prototype tests:

```bash
npm run test:contracts
```

## Continuous Integration

The [CI workflow](.github/workflows/ci.yml) runs on every push and pull request. It installs dependencies with `npm install`, validates the CI environment against `.env.example`, lints the repository, builds the Next.js app, and runs the smart contract and backend test suites.

The workflow uses intentionally non-production values for the configuration that would normally be supplied as secrets (`JWT_SECRET`, `PINATA_JWT`, and database settings). This checks that required settings are present and not placeholders without exposing deployment credentials to pull-request workflows. Production and deployment workflows must continue to provide real repository or environment secrets.

To add a new required check, first add an npm script, then add a clearly named step to `.github/workflows/ci.yml` after environment validation. If the check needs configuration, document its variable in `.env.example` and add it to `scripts/validate-ci-env.mjs` when it is required for CI.

## Documentation

- [Architecture](docs/architecture.md)
- [Project Workflows](docs/project-workflows.md)
- [User Flows](docs/user-flows.md)
- [Environment Setup](docs/environment-setup.md)
- [Contribution Guide](docs/contributing.md)
- [Backend Contracts](docs/backend-contracts.md)

## Deployment Notes

- Production deployments must use real values for required secrets.
- Placeholder secrets should not be used in preview or production environments.
- Required production values include `JWT_SECRET`, `MONGODB_URI`, `PINATA_JWT`, `NEXT_PUBLIC_APP_URL`, and `NEXT_PUBLIC_GATEWAY_URL`.
- Once Stellar features are enabled, production must also include valid Stellar RPC, Horizon, and contract configuration.

## Roadmap

### Near Term

- Clean up stale chain-specific UI references
- Improve creator onboarding and material publishing flows
- Finalize Soroban contract interfaces for registry and entitlement logic

### Next Milestone

- Add Stellar wallet support
- Deploy Soroban contracts to Stellar testnet
- Support XLM and USDC-based checkout
- Gate downloads based on on-chain entitlement state
- Add creator payout accounting

### Future Improvements

- Educator and institution verification
- Bulk licensing for schools and learning communities
- Institution-issued access assets and scholarship credits
- Creator analytics and reporting
- Mobile-first purchase flow for low-bandwidth environments

## Contributing

See the [Contribution Guide](docs/contributing.md) for the development workflow, documentation expectations, testing guidance, and pull request checklist.

Contributions are welcome. Please read the project contribution guide before opening a pull request.

Good areas to contribute include:

- Stellar wallet integration
- Soroban contract design
- Marketplace UI improvements
- Security reviews for access control and entitlement logic
- Documentation and developer experience improvements

## License

This project is licensed under the [MIT License](LICENSE).

## Maintainer

Maintained by [Obiajulu-gif](https://github.com/Obiajulu-gif).
