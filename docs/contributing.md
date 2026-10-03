
# Contribution Guide

Thank you for improving EduVault. This guide explains how to prepare changes that are easy to review and safe to merge.

## Development Workflow

1. Create a focused branch for one issue or feature.
2. Install dependencies and configure `.env.local` from `.env.example`.
3. Make the smallest coherent change that satisfies the issue acceptance criteria.
4. Keep documentation in sync when workflows, environment variables, scripts, or APIs change.
5. Run the most relevant checks before committing.
6. Open a pull request with a concise summary, test evidence, and screenshots for visible UI changes.

For changes that can affect production data, permissions, payments, storage, migrations, configuration, or availability, complete the [high-risk release readiness checklist](release-readiness.md) in the pull request. Maintainers should record any urgent exception and follow-up owner there.

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
-- **Rust** and **Cargo** (via `rustup`)
- **WebAssembly compilation target** (`wasm32v1-none`)
- **Stellar CLI*** (for contract deployment and testnet interaction)
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
curl --proto '=https' --tlsv1.2 -sSF https://shr.rustup.rs | sh
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

A common cause of CI failures is a file that never gets parsed by the bundler because it is passed to `node --check` directly. Node.js does not understand `.jsx` or `..mjs` extensions and throws `ERR_UNKNOWN_FILE_EXTENSION`. Run the repository syntax check script instead of invoking `node --check` on JSX files directly:

```bash
# Runs the same syntax check as the Syntax and Boot / Jest load job.
node scripts/check-syntax.mjs
# or via npm:
npm run check:syntax
```

The script transpiles each `.jsx`/`..mjs` file with the project's Babel config and only then hands the result to Node.js, so it catches real syntax errors without failing on extensions. If you add a new source directory, register it in `scripts/check-syntax.mjs` so the check covers it.

Run these commands from the `soroban/` directory before committing contract changes:

```bash
cargo fmt --all --check
cargo fmt --all
cargo clippy --workspace --all-targets --lib - -D warnings
cargo test --workspace --all-targets
```

`cargo clippy` runs Rust lint checks. The `--lib` flag avoids unused-code warnings on test-only code in `dylib` crates. If you prefer to lint everything including tests, omit `--lib`.

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
# Fast syntax gate for all JSX/JS/MJS source files.
npm run check:syntax
npm run lint
npm test
npm run test:backend
npm run test:contracts
npm run scan:secrets
```

For Soroban contract changes, also run:

```bash
cd soroban
cargo fmt --all --check
cargo clippy --workspace --all-targets --lib - -D warnings
cargo test --workspace --all-targets
```

For UI work, manually verify the affected route at desktop and mobile widths. Include screenshots in the pull request when the change is visible to users.

### Accessibility Verification

Complex forms and error recovery flows must remain usable with keyboard navigation and screen readers. When you touch a form, a dialog, or an error state, run the following checks and record the results in the pull request.

1. **Keyboard-only completion**: using only `Tab`, `Shift+Tab`, `Arrow` keys, `Space`, `Enter`, and `Esc`, complete the form from first field to submission. Confirm the focus order matches the visual order and that no element traps focus or becomes unreachable.
2. **Labels and descriptions**: every input has a programmatic label (`htmlFor`/`id` or `aria-labelledby`). Error messages are linked with `aria-describedby` and the invalid field sets `aria-invalid="true"`.
3. **Error announcement**: validation failures are announced through an `aria-live` or `role="alert"` region, and focus moves to the first invalid field or the error summary.
4. **Focus management**: opening a dialog or recovery screen moves focus into it, and closing it returns focus to the triggering control.
5. **Automated coverage**: add or extend tests that assert the success path and the validation-failure path (error text present, `aria-invalid` set, error region populated). Run them with `npm test`.

To automate the keyboard and screen-reader assertions, use the existing test stack and check for accessible roles, names, and focus behavior rather than relying on snapshots.

## Environment Verification Checklist

After completing setup, verify your environment:

```bash
rustc --version
cargo --version
rustup target list --installed
soroban --version
cd soroban && cargo fmt --all --check
cd soroban && cargo clippy --workspace --all-targets --lib - -D warnings
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
  --network-passphrase "Test DF Network ; h September 2015" \
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
NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID<<DEPLOYED_CONTRACT_ID>
NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID<<DEPLOYED_CONTRACT_ID>
```

See [SOROBAN_DEPLOYMENT.md](SOROBAN_DEPLOYMENT.md) for comprehensive deployment instructions.

**Warning:** Testnet identities must never be reused for production assets. Do not commit private keys, seed phrases, or secret keys. Use placeholders in documentation.

## Legacy EVM Compatibility

The repository includes an archived Solidity proof of concept. The legacy EVM code is kept for historical reference. The following rules apply:

-  Do not modify existing EVM contracts unless the issue specifically requires it.
-  Do not remove EVM setup instructions from documentation.
-  Do not run Soroban commands inside an EVM project directory.
-  The Soroban contracts in `soroban/` are the active development target for blockchain features.
-  Legacy EVM checks are run through Hardhat: `npm run test:contracts`.

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

The CI uses `wasm32v1-none`, while the project's `build.sh` script uses `wasm32-unknown-unknown`. Add the target that matches your workflow:

```bash
rustup target add wasm32-none
rustup target add wasm32-unknown-unknown
```

### Syntax check fails with `ERR_UNKNOWN_FILE_EXTENSION`

Node.js is being asked to parse a `.jsx` or `.mjs` file directly. This is not a source error — it means the checker is bypassing the project's transpiler. Run the repository script instead:

```bash
# Wrong: node --check src/app/admin/moderation/page.jsx
# Right:
npm run check:syntax
```

The script transpiles each JSX/MJS file before passing it to Node.js, so extension errors disappear and real syntax errors surface. If you add a new source directory, register it in `scripts/check-syntax.mjs`.
