# Environment Setup

This guide describes the local setup required to run EduVault and test the main marketplace workflows.

## Prerequisites

- Node.js 20 or newer
- npm 10 or a compatible pnpm version
- Docker, if you want to run MongoDB locally through `docker compose`
- A MongoDB connection string
- Pinata credentials for IPFS uploads
- Wallet tooling for testing wallet-connected flows

## Install Dependencies

```bash
npm install
```

The repository may include multiple lockfiles while package-manager usage is being consolidated. Prefer the package manager already used by your branch or team before regenerating lockfiles.

## Configure Environment Variables

Copy the example file and fill in local values:

```bash
cp .env.example .env.local
```

Required local values for the main app are:

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | MongoDB connection string used by API routes |
| `JWT_SECRET` | Secret used to sign local session tokens |
| `NEXT_PUBLIC_APP_URL` | Base URL for local links, usually `http://localhost:3000` |
| `PINATA_JWT` | Pinata API token used for uploads |
| `NEXT_PUBLIC_GATEWAY_URL` | Public gateway URL for reading pinned content |

Optional values include SMTP settings, WalletConnect project configuration, and planned Stellar/Soroban settings such as `NEXT_PUBLIC_STELLAR_NETWORK`, `NEXT_PUBLIC_STELLAR_RPC_URL`, `NEXT_PUBLIC_HORIZON_URL`, and `NEXT_PUBLIC_SOROBAN_CONTRACT_ID`.

## Start MongoDB

Use Docker when you do not already have a local or hosted MongoDB instance:

```bash
docker compose up -d mongodb
```

Set `MONGODB_URI` in `.env.local` to the connection string exposed by your local container or hosted database.

## Run the App

```bash
npm run dev
```

Open the local app at `http://localhost:3000`.

## Useful Checks

```bash
npm run lint
npm test
npm run test:backend
npm run scan:secrets
```

Run focused checks before opening a pull request, and add broader checks when you touch shared API, storage, or workflow code.

## Operational Scripts

- `npm run indexer:stellar` runs the Stellar indexer as a long-lived service: it
  polls for new events, checkpoints its cursor to `sync_state` after every
  batch, backs off exponentially on RPC failures, and shuts down cleanly on
  SIGINT/SIGTERM. Tunable via `INDEXER_POLL_INTERVAL_MS` (default 5000),
  `INDEXER_BATCH_LIMIT` (100), and `INDEXER_BACKOFF_MIN_MS` / `INDEXER_BACKOFF_MAX_MS`.
- `npm run indexer:stellar:once` processes a single batch and exits. Use this
  for cron-style deployments and one-shot rebuilds.
- `npm run indexer:stellar:recover` audits Horizon against the database and
  re-indexes payments that map to a known but unsettled purchase. Payments it
  cannot match to a purchase are reported as `orphanedTransactions` for manual
  review rather than written, because a payment carries no `materialId` of its
  own and inventing one grants access to a material that does not exist.
- `node scripts/reprocess-deadletter.mjs` retries dead-lettered indexer events.
  Only `retryable` rows are swept by default; rows that exhausted
  `INDEXER_MAX_RETRIES` (default 3) are left in the terminal `failed` state
  until an operator opts into them explicitly.
- `npm run indexer:repair -- 100` reconciles at most 100 legacy, interrupted,
  or failed event receipts. The command is bounded and safe to rerun because
  projections are idempotent.
- `node scripts/backup-mongodb.mjs` runs the MongoDB backup helper when configured.
