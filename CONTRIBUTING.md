# Contributing to EduVault

Thanks for contributing.

## Scope

EduVault is an in-development educational content marketplace with a current web prototype and a planned Stellar-native settlement layer. Contributions should improve one of these areas:

- product clarity
- security
- Soroban contract design
- developer experience
- accessibility
- documentation

## Before You Start

1. Read [README.md](README.md).
2. Review [docs/overview.md](docs/overview.md) and [docs/architecture.md](docs/architecture.md).
3. Review [docs/quota-management.md](docs/quota-management.md) for information on resource quotas and operations.
4. Open an issue before starting large changes so architecture and scope can be aligned early.

## Local Setup

**Package Manager**: `npm` is the canonical package manager for this repository. Please do not use `pnpm`, `bun`, or `yarn`. The canonical lockfile is `package-lock.json`.

```bash
npm install
cp .env.example .env.local
docker compose up -d mongodb
npm run dev
```

### Local Diagnostics

Before starting development, or if you encounter environment-related issues, run the local diagnostics command:

```bash
npm run diagnostics
```

This command checks your Node.js version, environment variables, database connectivity, and test fixtures. It will output clear pass/fail results along with actionable remediation steps if anything is misconfigured or missing.

### Windows Setup Notes
If you are using Windows PowerShell, you may encounter script execution policy errors when running `npx` or `npm` scripts. To resolve this, run PowerShell as Administrator and enable script execution:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```
Alternatively, use `cmd.exe` or Git Bash for development commands.

## CI Command Contract

GitHub Actions CI uses deterministic dependency installation. Pull requests must pass the following mandatory quality gates:
- **Lint**: `npm run lint`
- **Build**: `npm run build`
- **Typecheck**: `npm run typecheck`
- **Tests**: `npm run test:frontend`, `npm run test:backend`, `npm run test:contracts`, `npm run test:integration`

The CI environment installs dependencies using `npm ci`. Ensure your `package-lock.json` is up-to-date and committed. Pull requests failing these gates will be blocked from merging.

## Testing

### E2E Purchase Flow Tests

The project includes comprehensive end-to-end test coverage for the highest-risk user journey: the purchase/checkout flow. These tests are located in `test/integration/purchase-flow-e2e.test.js` and cover:

- Happy path: successful purchase from quote to entitlement
- Validation failures: invalid inputs and missing fields
- Payment failures: expired quotes and payment processing errors
- Duplicate purchase prevention: idempotency and race conditions
- Retry and recovery: idempotency keys and interrupted checkouts
- Access control: entitlement verification after purchase

To run the E2E purchase flow tests:

```bash
npm test -- test/integration/purchase-flow-e2e.test.js
```

To validate the E2E test coverage:

```bash
npm run validate:e2e-purchase
```

See [docs/e2e-purchase-flow-coverage.md](docs/e2e-purchase-flow-coverage.md) for detailed documentation of the test suite.

### Soroban Contract Setup

If you are contributing to smart contracts, additional Rust tooling is required. See the [detailed Soroban setup instructions](docs/contributing.md#rust-and-soroban-prerequisites) in the full contribution guide.

Quick summary:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32v1-none wasm32-unknown-unknown
cargo install --locked soroban-cli --version 25.3.1
cd soroban && cargo test --workspace --all-targets
```

The CI uses `wasm32v1-none` for builds, while the project `build.sh` script uses `wasm32-unknown-unknown`. Install both targets to work with either build method.

## Branching

- Use a short descriptive branch name such as `docs/stellar-submission` or `feat/entitlement-checks`.
- Keep pull requests focused. Avoid mixing documentation, refactors, and feature work unless the changes are tightly coupled.

## Coding Standards

- Keep changes small and reviewable.
- Prefer explicit naming over clever abstractions.
- Preserve the distinction between current prototype behavior and planned Stellar milestones.
- Do not claim a feature is on Stellar unless it is implemented and testable in this repository.
- Do not add new product work to the archived EVM prototype unless there is an explicit architecture decision to do so.
- Update documentation when architecture or environment requirements change.

## Pull Request Checklist

- The change is scoped and explained clearly.
- Relevant docs are updated.
- New environment variables are reflected in `.env.example`.
- Pull requests that change visible frontend behavior include screenshots or a short screen recording.
- Request/response examples are included when backend or API changes materially benefit from them.
- Any product or architectural assumptions are stated explicitly in the PR description.

## Commit Messages

Use concise, conventional commit messages when possible:

- `docs: rewrite README for Drip Wave submission`
- `chore: add contributor and license files`
- `docs: document Stellar architecture direction`
- `feat: add Soroban contract scaffolding`

## Reporting Issues

When opening an issue, include:

- expected behavior
- actual behavior
- reproduction steps
- screenshots or logs if relevant
- whether the issue affects the current prototype or the planned Stellar milestone

## Security

Do not disclose secrets, private keys, or production credentials in issues or pull requests. If you discover a sensitive security issue, contact the maintainer privately before public disclosure.

## Operational incidents

Maintainers responding to a production incident should follow the
[incident triage and emergency rollback runbook](docs/incident-triage-runbook.md).
It identifies safe diagnostics, containment and rollback decision points, and
the reconciliation checks required before recovery is announced. Contributors
must not add credentials, signed URLs, raw student records, or unredacted logs
to incident reports or pull requests.

🌟 Stellar Contributors: See the [Stellar Integration Guide](docs/stellar-integration.md) for setup instructions. See the [full contribution guide](docs/contributing.md) for detailed Rust and Soroban setup steps.
