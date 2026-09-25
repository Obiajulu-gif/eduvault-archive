# Contribution Guide

Thank you for improving EduVault. This guide explains how to prepare changes that are easy to review and safe to merge.

## Development Workflow

1. Create a focused branch for one issue or feature.
2. Install dependencies and configure `.env.local` from `.env.example`.
3. Make the smallest coherent change that satisfies the issue acceptance criteria.
4. Keep documentation in sync when workflows, environment variables, scripts, or APIs change.
5. Run the most relevant checks before committing.
6. Open a pull request with a concise summary, test evidence, and screenshots for visible UI changes.

## Quick Start: One-Command Bootstrap

Contributors can reach a fully working local state in a single command:

```bash
bash scripts/bootstrap-local.sh
# or via npm:
npm run bootstrap:local
```

This installs dependencies, starts MongoDB, seeds all fixture data, and
(optionally) builds the Soroban contracts. See
[environment-setup.md](environment-setup.md) for the full list of what it
does and how to run individual steps.

To skip the Soroban build (faster iteration for frontend or backend work):

```bash
npm run bootstrap:local:fast
```

To reseed fixture data only:

```bash
npm run seed:local
```

---

## Frontend and Backend Setup

For contributors working on the Next.js application, API routes, or UI:

```bash
npm install
cp .env.example .env.local
docker compose up -d mongodb
npm run dev
```

See [environment-setup.md](environment-setup.md) for detailed environment variable configuration.

## Rust and Soroban Prerequisites

Contributors working on smart contracts in the `soroban/` directory need the following additional tools:

- **Git**
- **Rust** and **Cargo** (via `rustup`)
- **WebAssembly compilation target** (`wasm32v1-none`)
- **Stellar CLI** (for contract deployment and testnet interaction)
- **Operating system build tools** (C compiler/linker)

Frontend-only contributors do not need these tools unless they are also building or testing Soroban contracts.

## Supported Operating Systems

### Linux

Standard support. Install build tools:

```bash
sudo apt install build-essential
```

### macOS

Install the Xcode command-line tools:

```bash
xcode-select --install
```

### Windows

Native Windows development of the Soroban contracts requires additional setup. The most reliable path on Windows is **Windows Subsystem for Linux (WSL 2)**:

```powershell
wsl --install
```

After restarting, open a WSL terminal and follow the Linux instructions above. If you are only working on the frontend, native Windows with Node.js works without WSL.

## Rust Installation

Install Rust through `rustup`, the official installer:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Follow the prompts and accept the defaults. After installation, verify:

```bash
rustc --version
cargo --version
rustup --version
```

If you need to update later:

```bash
rustup update
```

## Rust Toolchain

This repository does not pin a specific Rust toolchain via `rust-toolchain.toml`. The CI builds and tests use the **stable** channel. Install and verify the stable toolchain:

```bash
rustup toolchain install stable
rustup default stable
rustup show
```

Confirm the active toolchain is `stable` with a recent date.

## WebAssembly Compilation Target

Soroban contracts compile to WebAssembly. The compilation pipeline targets `wasm32v1-none`, which restricts features to the WebAssembly 1.0 subset supported by the Soroban runtime. Add this target:

```bash
rustup target add wasm32v1-none
```

Verify the target is installed:

```bash
rustup target list --installed
```

You should see `wasm32v1-none` in the list.

## Stellar CLI Installation

The Stellar CLI provides the `stellar` (and aliased `soroban`) command used for contract deployment and testnet interaction. Install the official `stellar-cli` package:

```bash
cargo install --locked stellar-cli --version 25.2.0
```

Verify:

```bash
stellar --version
```

The CLI binary is placed in `$HOME/.cargo/bin`. See the next section if the command is not found.

## PATH Configuration

The Rust installer places binaries in `$HOME/.cargo/bin`. If `rustc`, `cargo`, or `soroban` are not found after installation, source the environment file:

```bash
source "$HOME/.cargo/env"
```

On Windows with WSL, the same command applies inside the WSL shell. On native Windows PowerShell, the installer typically adds the path automatically; restart the terminal if needed.

## Repository Setup

Clone the repository and enter the workspace:

```bash
git clone https://github.com/Obiajulu-gif/eduvault-archive.git
cd eduvault-archive
```

For the frontend:

```bash
npm install
cp .env.example .env.local
```

For the Soroban contracts:

```bash
cd soroban
cargo fetch
```

## Building Soroban Contracts

The contracts live in the `soroban/` directory, which contains a Cargo workspace with three members:

- `contracts/material-registry`
- `contracts/purchase-manager`
- `contracts/shared-interface`

### Using the build script

```bash
cd soroban
./build.sh
```

### Building manually

```bash
cd soroban
cargo build --target wasm32-unknown-unknown --release
```

### Building with the CI target

```bash
cd soroban
cargo build --target wasm32v1-none --release
```

The WASM output appears under `soroban/target/wasm32-unknown-unknown/release/` (or the corresponding `wasm32v1-none` directory). The `.gitignore` excludes the `soroban/target/` directory, so build artifacts are not committed.

## Running Contract Tests

Run all Soroban workspace tests:

```bash
cd soroban
cargo test --workspace --all-targets
```

To run tests for a single contract:

```bash
cd soroban
cargo test -p material-registry
cargo test -p purchase-manager
```

Using the provided test script:

```bash
cd soroban
./run-tests.sh
```

The tests use Soroban's local test environment and do not require network access or testnet credentials.

## Formatting and Static Analysis

Run these commands from the `soroban/` directory before committing contract changes:

```bash
cargo fmt --all -- --check
cargo fmt --all
cargo clippy --workspace --all-targets --lib -- -D warnings
cargo test --workspace --all-targets
```

`cargo clippy` runs Rust lint checks. The `--lib` flag avoids unused-code warnings on test-only code in `cdylib` crates. If you prefer to lint everything including tests, omit `--lib`.

For the frontend and backend:

```bash
npm run lint
npm test
npm run scan:secrets
```

See the [Testing Expectations](#testing-expectations) section below for the full validation sequence.

## Testing Expectations

Use the narrowest reliable test first, then broaden as needed:

```bash
npm run lint
npm test
npm run test:backend
npm run test:contracts
npm run scan:secrets
```

For Soroban contract changes, also run:

```bash
cd soroban
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --lib -- -D warnings
cargo test --workspace --all-targets
```

For UI work, manually verify the affected route at desktop and mobile widths. Include screenshots in the pull request when the change is visible to users.

## Environment Verification Checklist

After completing setup, verify your environment:

```bash
rustc --version
cargo --version
rustup target list --installed
soroban --version
cd soroban && cargo fmt --all -- --check
cd soroban && cargo clippy --workspace --all-targets --lib -- -D warnings
cd soroban && cargo test --workspace --all-targets
cd soroban && cargo build --target wasm32v1-none --release
```

Successful setup means:

- Rust and Cargo return version numbers
- `wasm32v1-none` appears in the installed target list
- `soroban --version` returns a version
- `cargo fmt` reports no formatting changes needed
- `cargo clippy` produces no warnings
- Contract tests pass
- Contract WASM builds successfully

## Testnet Configuration

If your work requires deploying or interacting with contracts on the Stellar testnet, configure your CLI to use the testnet network and set up a development identity.

### Add the testnet network

```bash
soroban network add \
  --rpc-url https://soroban-testnet.stellar.org:443 \
  --network-passphrase "Test SDF Network ; September 2015" \
  testnet
```

### Generate a development identity

```bash
soroban config identity generate --global eduvault-deployer
```

View the identity's public key:

```bash
soroban config identity show --global eduvault-deployer
```

### Fund the account

Use Friendbot to get testnet XLM:

```bash
curl "https://friendbot.stellar.org/?addr=<YOUR_PUBLIC_KEY>"
```

### Verify connectivity

Build the contract first (from the repository root or the `soroban/` directory), then deploy:

```bash
cd soroban
cargo build --target wasm32-unknown-unknown --release
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/material_registry.wasm \
  --source eduvault-deployer \
  --network testnet
```

### Record contract IDs

After deployment, add the contract IDs to your `.env.local`:

```
NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID=<DEPLOYED_CONTRACT_ID>
NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID=<DEPLOYED_CONTRACT_ID>
```

See [SOROBAN_DEPLOYMENT.md](SOROBAN_DEPLOYMENT.md) for comprehensive deployment instructions.

**Warning:** Testnet identities must never be reused for production assets. Do not commit private keys, seed phrases, or secret keys. Use placeholders in documentation.

## Legacy EVM Compatibility

The repository includes an archived Solidity proof of concept. The legacy EVM code is kept for historical reference. The following rules apply:

- Do not modify existing EVM contracts unless the issue specifically requires it.
- Do not remove EVM setup instructions from documentation.
- Do not run Soroban commands inside an EVM project directory.
- The Soroban contracts in `soroban/` are the active development target for blockchain features.
- Legacy EVM tests are run through Hardhat: `npm run test:contracts`.

Both the Soroban and legacy EVM workflows are checked independently in CI. Changes to one should not break the other.

## Troubleshooting

### Rust or Cargo command not found

Open a new terminal or source the environment:

```bash
source "$HOME/.cargo/env"
```

### stellar or soroban command not found

Confirm `$HOME/.cargo/bin` is in your `PATH` and that the installation completed:

```bash
which stellar
stellar --version
```

If not installed, run:

```bash
cargo install --locked stellar-cli --version 25.2.0
```

### Missing WebAssembly target

The CI uses `wasm32v1-none`, while the project's `build.sh` script uses `wasm32-unknown-unknown`. Install both:

```bash
rustup target add wasm32v1-none
```

If `wasm32v1-none` is not available via `rustup target add`, ensure your Rust toolchain is up to date:

```bash
rustup update stable
```

The target requires Rust 1.80+ and a compatible nightly or recent stable toolchain. On Windows without WSL, you may need to use the **GNU toolchain** instead of the MSVC one if the target is not listed:

```bash
rustup toolchain install stable-x86_64-pc-windows-gnu
rustup default stable-x86_64-pc-windows-gnu
```

### Linker or compiler errors

Install your platform's build tools:

- **Linux:** `sudo apt install build-essential`
- **macOS:** `xcode-select --install`
- **Windows (WSL):** Follow the Linux instructions inside WSL

### Incorrect Rust toolchain

```bash
rustup show
rustup default stable
```

### Clippy produces unexpected warnings

The `--lib` flag limits checks to library code and avoids unused-code warnings in test modules of `cdylib` crates. Run without `--lib` if you intend to lint test code too:

```bash
cargo clippy --workspace --all-targets -- -D warnings
```

Some Soroban-generated code may trigger Clippy pedantic rules by design. The `-D warnings` flag ensures no warnings are silently introduced.

### Contract build fails

- Confirm you are in the `soroban/` directory.
- Check `soroban --version` or `cargo --version` for a working toolchain.
- Ensure the correct WASM target is installed.
- Try cleaning stale output: `cargo clean` inside `soroban/`.

### PowerShell differences on Windows

If using native Windows PowerShell instead of WSL, note that shell scripts (`build.sh`, `run-tests.sh`) require a Unix-like shell. Use Git Bash or WSL to run them. The `cargo` and `rustup` commands work natively in PowerShell when using the MSVC toolchain, but the `wasm32v1-none` target may require the GNU toolchain on some Windows configurations.

### soroban command refers to the Stellar CLI

The `soroban` binary is installed by the `soroban-cli` crate (version 25.3.1). Newer unified Stellar CLI versions provide the same commands under the `stellar` binary. This repository uses the `soroban` binary. If you have installed `stellar-cli` instead, verify that the `soroban` subcommand is available:

```bash
stellar soroban --version
```

If you need to install the `soroban` binary directly:

```bash
cargo install --locked soroban-cli --version 25.3.1
```

## Coding Guidelines

- Prefer clear, accessible UI states for loading, empty, error, and success paths.
- Keep marketplace behavior mobile-friendly by default.
- Validate API inputs before writing to MongoDB or external services.
- Do not commit real secrets, private keys, API tokens, or production connection strings.
- Avoid broad refactors in feature branches unless the issue specifically requires them.
- Preserve the distinction between shipped prototype functionality and planned Stellar/Soroban functionality.

## Documentation Guidelines

Update docs when a change affects:

- creator, learner, checkout, or marketplace workflows
- setup steps, required versions, environment variables, or scripts
- API contracts or database collections
- deployment, indexing, backup, or recovery operations
- Stellar/Soroban architecture or integration assumptions

## Pull Request Checklist

- The PR title clearly describes the user-facing or developer-facing change.
- The PR body explains what changed and why.
- Relevant tests or checks are listed with pass/fail status.
- Screenshots are attached for perceptible UI changes.
- New environment variables are documented in `.env.example` and project docs.
- Database, indexing, or migration impacts are called out explicitly.
- Known follow-up work is documented rather than hidden.
