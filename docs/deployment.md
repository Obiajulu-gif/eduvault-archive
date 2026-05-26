# EduVault Deployment Guide

Step-by-step instructions for deploying the full EduVault stack (Next.js frontend + API, MongoDB, and Soroban smart contracts) from scratch.

---

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Node.js | ≥ 20 | Next.js runtime |
| npm | ≥ 10 | Package manager |
| Rust + Cargo | stable | Compile Soroban contracts |
| Stellar CLI (`stellar`) | ≥ 21 | Deploy and invoke contracts |
| Docker | ≥ 24 | Local MongoDB |
| `mongodump` / `mongorestore` | ≥ 100.9 | Backup / restore |

Install the Stellar CLI:

```bash
cargo install --locked stellar-cli
```

---

## 1. Environment Variables

Copy `.env.example` to `.env.local` and fill in every value before starting:

```bash
cp .env.example .env.local
```

### Required for all environments

| Variable | Description |
|---|---|
| `MONGODB_URI` | Full MongoDB connection string |
| `MONGODB_DB` | Database name (default `eduvault`) |
| `JWT_SECRET` | ≥ 32 random bytes — used to sign auth tokens |
| `NEXT_PUBLIC_APP_URL` | Public URL of the deployed app |
| `PINATA_JWT` | Pinata API key for IPFS uploads |
| `NEXT_PUBLIC_GATEWAY_URL` | Pinata / IPFS gateway base URL |

### Required for Stellar / Soroban features

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_STELLAR_NETWORK` | `testnet` or `mainnet` |
| `NEXT_PUBLIC_STELLAR_RPC_URL` | Soroban RPC endpoint |
| `NEXT_PUBLIC_HORIZON_URL` | Horizon REST API base URL |
| `NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID` | Deployed `MaterialRegistry` contract ID |
| `NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID` | Deployed `PurchaseManager` contract ID |

### Required for the MongoDB backup cron (GitHub Actions)

| Secret | Description |
|---|---|
| `BACKUP_MONGODB_URI` | Connection string with backup-user credentials |
| `BACKUP_S3_BUCKET` | Destination S3 / R2 bucket name |
| `BACKUP_S3_REGION` | AWS region (e.g., `us-east-1`) |
| `BACKUP_S3_ENDPOINT` | Custom endpoint for Cloudflare R2 / MinIO (optional) |
| `BACKUP_AWS_ACCESS_KEY_ID` | Access key for backup bucket |
| `BACKUP_AWS_SECRET_ACCESS_KEY` | Secret key for backup bucket |
| `BACKUP_SLACK_WEBHOOK_URL` | Slack Incoming Webhook for failure alerts (optional) |

### Optional / monitoring

| Variable | Description |
|---|---|
| `SENTRY_DSN` | Sentry project DSN — omit to disable error tracking |
| `NEXT_PUBLIC_SENTRY_DSN` | Same DSN exposed to the browser bundle |

---

## 2. Local Development

```bash
# Start MongoDB
docker compose up -d

# Install dependencies
npm install

# Run the Next.js dev server
npm run dev
# → http://localhost:3000
```

The interactive API docs are available at `http://localhost:3000/api-docs`.

---

## 3. Soroban Contract Deployment

### 3a. Configure the Stellar CLI identity

```bash
# Generate a new keypair (skip if you already have one)
stellar keys generate deployer --network testnet

# Fund on testnet via Friendbot
stellar keys fund deployer --network testnet
```

### 3b. Build the contracts

```bash
cd soroban
cargo build --target wasm32-unknown-unknown --release
```

Compiled WASM files land in `target/wasm32-unknown-unknown/release/`.

### 3c. Deploy `MaterialRegistry`

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/material_registry.wasm \
  --source deployer \
  --network testnet
# → prints the contract ID — save it as NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID
```

### 3d. Deploy `PurchaseManager`

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/purchase_manager.wasm \
  --source deployer \
  --network testnet
# → prints the contract ID — save it as NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID
```

### 3e. Initialise the contracts

Replace `<CONTRACT_ID>` and `<ADMIN_ADDRESS>` with your values:

```bash
# Initialise MaterialRegistry
stellar contract invoke \
  --id <MATERIAL_REGISTRY_CONTRACT_ID> \
  --source deployer \
  --network testnet \
  -- init \
  --admin <ADMIN_ADDRESS>

# Initialise PurchaseManager
stellar contract invoke \
  --id <PURCHASE_MANAGER_CONTRACT_ID> \
  --source deployer \
  --network testnet \
  -- init \
  --admin <ADMIN_ADDRESS> \
  --registry <MATERIAL_REGISTRY_CONTRACT_ID>
```

---

## 4. Vercel Deployment

### 4a. Import the project

1. Push your fork to GitHub.
2. Open [vercel.com/new](https://vercel.com/new) → **Import Git Repository**.
3. Select the `eduvault` repository.
4. Set **Framework Preset** to **Next.js**.

### 4b. Configure environment variables

In the Vercel dashboard → **Settings → Environment Variables**, add every entry from the table in Section 1 above.

Set `NEXT_PUBLIC_APP_URL` to your Vercel deployment URL (e.g., `https://eduvault.vercel.app`).

### 4c. Deploy

```bash
# One-shot deploy via Vercel CLI
npx vercel --prod
```

Or push to the `main` branch — Vercel auto-deploys on every push.

---

## 5. CI/CD — GitHub Actions

The repository ships with two workflows:

| Workflow | File | Trigger |
|---|---|---|
| Backend CI (lint + build) | `.github/workflows/backend.yml` | PR / push to `main` or `develop` |
| MongoDB daily backup | `.github/workflows/backup.yml` | Daily cron at 02:00 UTC + manual |

### Required GitHub Secrets for backup workflow

Add the secrets listed in the _backup cron_ table in Section 1 to **Repository Settings → Secrets and variables → Actions**.

### Manual backup trigger

```
GitHub → Actions → MongoDB Backup → Run workflow
```

---

## 6. Database Backup and Recovery

### Run a backup manually

```bash
# Requires mongodump in PATH and all BACKUP_* env vars set
node scripts/backup-mongodb.mjs
```

### Restore from a backup archive

```bash
# Download the archive from S3
aws s3 cp s3://<BACKUP_S3_BUCKET>/backups/YYYY-MM/eduvault-backup-<TIMESTAMP>.gz ./restore.gz

# Restore (will overwrite existing collections)
mongorestore \
  --uri="$MONGODB_URI" \
  --archive=./restore.gz \
  --gzip \
  --drop
```

### Recovery testing checklist

Run this checklist after every significant schema migration:

- [ ] Create a fresh backup with `node scripts/backup-mongodb.mjs`.
- [ ] Spin up a separate MongoDB instance (e.g., `docker run -p 27018:27017 mongo:7`).
- [ ] Restore the backup to the test instance.
- [ ] Start the app pointing at the test instance and verify core flows (login, list materials, purchase).
- [ ] Delete the test instance.

---

## 7. Monitoring and Error Tracking (Sentry)

1. Create a project at [sentry.io](https://sentry.io).
2. Copy the DSN from **Settings → Projects → Client Keys**.
3. Set `SENTRY_DSN` (server-side) and `NEXT_PUBLIC_SENTRY_DSN` (client-side) in Vercel.
4. Deploy — unhandled API exceptions are automatically captured via `withApiHardening`.

For Slack alerts on critical errors, configure an alert rule in Sentry pointing to your Slack workspace.

---

## 8. Rollback Procedure

```bash
# Roll back to the previous Vercel deployment
npx vercel rollback

# Or re-deploy a specific git commit
git checkout <commit-sha>
npx vercel --prod
```

For contract rollbacks, re-deploy the previous WASM binary and update the contract IDs in Vercel environment variables.
