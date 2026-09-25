# Environment Setup

This guide describes the local setup required to run EduVault and test the main marketplace workflows.

## Prerequisites

- Node.js 20 or newer
- npm 10 or a compatible pnpm version
- Docker, if you want to run MongoDB locally through `docker compose`
- A MongoDB connection string
- Pinata credentials for IPFS uploads
- Wallet tooling for testing wallet-connected flows

For contributors working on Soroban smart contracts in `soroban/`:

- Rust and Cargo (stable channel via `rustup`)
- WebAssembly target `wasm32v1-none`
- Stellar CLI (`cargo install --locked stellar-cli --version 25.2.0`)
- OS build tools (`build-essential` on Linux, Xcode Command Line Tools on macOS; Windows contributors using WSL 2 must install `build-essential` inside their WSL environment)
- See the [Contribution Guide](contributing.md#rust-and-soroban-prerequisites) for full setup instructions.

## One-Command Local Bootstrap

The fastest path from a fresh checkout to a working local environment is the
bootstrap script. It handles all of the steps below automatically:

```bash
bash scripts/bootstrap-local.sh
```

Or via npm:

```bash
npm run bootstrap:local
```

For a faster iteration loop that skips the Soroban contract build and smoke
test:

```bash
npm run bootstrap:local:fast
# equivalent: bash scripts/bootstrap-local.sh --skip-contracts --skip-smoke
```

The bootstrap script is **idempotent** — running it multiple times is safe and
produces the same local state. It:

1. Checks prerequisites (Node ≥ 20, npm, Docker, optional Rust/stellar-cli).
2. Copies `.env.example` → `.env.local` if not present.
3. Runs `npm install`.
4. Starts MongoDB via `docker compose up -d mongodb`.
5. Waits for MongoDB to be ready.
6. Runs `node scripts/setup-db-indexes.js`.
7. Seeds deterministic fixture data (3 creators, 3 buyers, 6 materials,
   3 purchases, 3 entitlement entries, 2 refunds) via
   `node scripts/seed-local-fixtures.mjs`.
8. Optionally builds Soroban contracts (`cd soroban && bash build.sh`).
9. Runs the local smoke test (`node scripts/smoke-local.mjs`).
10. Prints a summary with app URL, seed account credentials, and next steps.

To reseed fixture data without re-running the full bootstrap:

```bash
npm run seed:local
# or to force-replace existing fixtures:
FORCE_RESEED=true npm run seed:local
```

To run only the local smoke test:

```bash
npm run smoke:local
```

---

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

| Variable                  | Purpose                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `MONGODB_URI`             | MongoDB connection string used by API routes                                        |
| `JWT_SECRET`              | Secret used to sign local session tokens                                            |
| `NEXT_PUBLIC_APP_URL`     | Base URL for local links, usually `http://localhost:3000`                           |
| `PINATA_JWT`              | Pinata API token used for uploads                                                   |
| `NEXT_PUBLIC_GATEWAY_URL` | Public gateway URL for reading pinned content                                       |
| `REDIS_URL`               | Redis connection URL for distributed sliding-window rate limiting and catalog cache |

Optional values include SMTP settings, WalletConnect project configuration, and planned Stellar/Soroban settings such as `NEXT_PUBLIC_STELLAR_NETWORK`, `NEXT_PUBLIC_STELLAR_RPC_URL`, `NEXT_PUBLIC_HORIZON_URL`, and `NEXT_PUBLIC_SOROBAN_CONTRACT_ID`.

## Fail-fast environment validation

EduVault validates the environment before serving traffic and before a
production build (`next build`, `next start`, and `next dev` all check). A
missing or placeholder value for a required variable, a malformed Soroban
contract ID, or a placeholder/short webhook secret aborts startup with a
listing of every problem instead of failing later at request time.

Checks that apply:

- **Contract IDs** — `NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID`,
  `NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID`, and
  `NEXT_PUBLIC_SOROBAN_CONTRACT_ID` must be well-formed 56-character
  `C`-prefixed Stellar addresses once set. A `0x…` address or a truncated
  value is rejected.
- **Webhook secrets** — when webhooks are enabled (`WEBHOOK_URL`,
  `STELLAR_WEBHOOK_SECRET`, or `CRON_SECRET` set), the signing secret must
  be present and at least 32 characters in production.
- **Placeholders** — values such as `replace-with-a-long-random-string`,
  `YOUR_PINATA_JWT`, and the like are rejected in production.

The check is skipped under CI (`CI=true`) so automated builds can run
without a full deployment `.env`. To debug a failed startup, run
`node -e "process.env.NODE_ENV='production'; import('./src/lib/env.js').then((m)=>console.log(m.validateRuntimeEnv()))"`
or run the unit tests in `src/lib/__tests__/env.test.js`.

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

- `npm run indexer:stellar` starts the Stellar indexer prototype.
- `node scripts/reprocess-deadletter.mjs` retries dead-lettered indexer events.
- `node scripts/backup-mongodb.mjs` runs the MongoDB backup helper when configured.
- `bash scripts/smoke-test.sh` runs the post-deploy purchase lifecycle smoke test (verifies material publish, quote, purchase, entitlement, download, and refunds).
