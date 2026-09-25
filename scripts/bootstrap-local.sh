#!/usr/bin/env bash
# =============================================================================
# bootstrap-local.sh — one-command local development bootstrap
#
# Usage:
#   bash scripts/bootstrap-local.sh [--skip-contracts] [--skip-smoke]
#
# What it does (in order):
#   1. Checks prerequisites (Node, npm, Docker, optional: Rust/cargo/stellar)
#   2. Copies .env.example → .env.local if .env.local is missing
#   3. Installs npm dependencies
#   4. Starts MongoDB via docker compose (idempotent)
#   5. Waits for MongoDB to be ready
#   6. Sets up database indexes
#   7. Seeds deterministic, idempotent fixture data:
#        • 3 creator accounts
#        • 6 published materials (2 per creator, varied price/type)
#        • 3 buyer accounts with completed purchases
#        • 2 refund records (one pending, one completed)
#        • Entitlement cache entries derived from purchases
#   8. (optional, --skip-contracts skips) Builds Soroban contracts
#   9. (optional, --skip-smoke skips) Runs the local smoke test
#  10. Prints a summary with app URL, test credentials, and next steps
#
# Idempotency: every seed upsert uses a deterministic _id derived from the
# fixture key, so re-running the script is safe and produces the same state.
#
# Prerequisites for full run:
#   • Node.js ≥ 20
#   • npm ≥ 10
#   • Docker + docker compose
#   • (optional) Rust/cargo + stellar-cli ≥ 25.2.0 for Soroban contract builds
#
# =============================================================================
set -euo pipefail

SKIP_CONTRACTS=false
SKIP_SMOKE=false
for arg in "$@"; do
  case "$arg" in
    --skip-contracts) SKIP_CONTRACTS=true ;;
    --skip-smoke)     SKIP_SMOKE=true ;;
  esac
done

# ── colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[bootstrap]${RESET} $*"; }
success() { echo -e "${GREEN}[bootstrap] ✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}[bootstrap] ⚠${RESET} $*"; }
fail()    { echo -e "${RED}[bootstrap] ✗ FATAL:${RESET} $*"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo ""
echo -e "${BOLD}=================================================="
echo " EduVault — Local Development Bootstrap"
echo -e "==================================================${RESET}"
echo ""

# ── Step 1: prerequisite checks ──────────────────────────────────────────────
info "Step 1/10 — Checking prerequisites"

check_cmd() {
  local cmd="$1" label="${2:-$1}"
  if ! command -v "$cmd" &>/dev/null; then
    return 1
  fi
  return 0
}

if ! check_cmd node; then
  fail "Node.js is not installed. Install Node.js ≥ 20 from https://nodejs.org"
fi

NODE_MAJOR=$(node -e "process.stdout.write(String(parseInt(process.versions.node)))")
if (( NODE_MAJOR < 20 )); then
  fail "Node.js ≥ 20 required. Current: $(node --version)"
fi
success "Node.js $(node --version)"

if ! check_cmd npm; then
  fail "npm is not installed."
fi
success "npm $(npm --version)"

if ! check_cmd docker; then
  fail "Docker is not installed. Install Docker Desktop or Docker Engine."
fi
success "Docker $(docker --version | head -1)"

DOCKER_COMPOSE_CMD=""
if docker compose version &>/dev/null 2>&1; then
  DOCKER_COMPOSE_CMD="docker compose"
elif check_cmd docker-compose; then
  DOCKER_COMPOSE_CMD="docker-compose"
else
  fail "Neither 'docker compose' (plugin) nor 'docker-compose' (standalone) found."
fi
success "Docker Compose available ($DOCKER_COMPOSE_CMD)"

if [ "$SKIP_CONTRACTS" = false ]; then
  if ! check_cmd cargo; then
    warn "cargo not found — Soroban contract build will be skipped (pass --skip-contracts to silence)."
    SKIP_CONTRACTS=true
  else
    success "cargo $(cargo --version)"
    if ! check_cmd stellar && ! check_cmd soroban; then
      warn "stellar/soroban CLI not found — contract deployment skipped. Install: cargo install --locked stellar-cli --version 25.2.0"
    fi
  fi
fi

echo ""

# ── Step 2: .env.local ────────────────────────────────────────────────────────
info "Step 2/10 — Environment file"

if [ ! -f .env.local ]; then
  cp .env.example .env.local
  success "Copied .env.example → .env.local"
  info  "Review .env.local and fill in any required values before production use."
else
  success ".env.local already exists — skipping copy"
fi

# Inject local-dev defaults for fields that are empty and needed for seeding.
# These placeholders are safe for local development only.
_inject_env() {
  local key="$1" val="$2"
  if ! grep -q "^${key}=" .env.local || grep -q "^${key}=$" .env.local; then
    # Key missing or empty — set it
    if grep -q "^${key}=" .env.local; then
      sed -i "s|^${key}=.*|${key}=${val}|" .env.local
    else
      echo "${key}=${val}" >> .env.local
    fi
  fi
}

_inject_env "MONGODB_URI"       "mongodb://localhost:27017/eduvault"
_inject_env "MONGODB_DB"        "eduvault"
_inject_env "JWT_SECRET"        "local-dev-jwt-secret-replace-in-production"
_inject_env "NEXT_PUBLIC_APP_URL" "http://localhost:3000"

echo ""

# ── Step 3: npm install ───────────────────────────────────────────────────────
info "Step 3/10 — Installing npm dependencies"

if [ ! -d node_modules ] || [ package.json -nt node_modules/.package-lock.json ] 2>/dev/null; then
  npm install --prefer-offline 2>&1 | tail -5
  success "npm install complete"
else
  success "node_modules up-to-date — skipping install"
fi

echo ""

# ── Step 4: start MongoDB ────────────────────────────────────────────────────
info "Step 4/10 — Starting MongoDB via docker compose"

$DOCKER_COMPOSE_CMD up -d mongodb 2>&1 | grep -v "^$" || true
success "MongoDB container started (or already running)"

echo ""

# ── Step 5: wait for MongoDB ─────────────────────────────────────────────────
info "Step 5/10 — Waiting for MongoDB to be ready"

MONGO_READY=false
for i in $(seq 1 30); do
  if docker exec "$(docker ps -qf name=mongodb | head -1)" mongosh --quiet --eval "db.adminCommand('ping')" &>/dev/null 2>&1; then
    MONGO_READY=true
    break
  fi
  sleep 1
done

if [ "$MONGO_READY" = false ]; then
  # Fallback: try via mongosh directly if installed locally
  for i in $(seq 1 10); do
    if mongosh --quiet mongodb://localhost:27017 --eval "db.adminCommand('ping')" &>/dev/null 2>&1; then
      MONGO_READY=true
      break
    fi
    sleep 1
  done
fi

if [ "$MONGO_READY" = false ]; then
  warn "MongoDB readiness check timed out. Continuing — seed may fail if MongoDB is not up."
else
  success "MongoDB is ready"
fi

echo ""

# ── Step 6: database indexes ──────────────────────────────────────────────────
info "Step 6/10 — Setting up database indexes"

if node scripts/setup-db-indexes.js 2>&1 | tail -5; then
  success "Database indexes configured"
else
  warn "setup-db-indexes.js returned a non-zero exit. Check MongoDB connection."
fi

echo ""

# ── Step 7: seed fixture data ─────────────────────────────────────────────────
info "Step 7/10 — Seeding deterministic fixture data"

node scripts/seed-local-fixtures.mjs && success "Fixture data seeded" || {
  warn "Seeding produced warnings — see output above. App may still function."
}

echo ""

# ── Step 8: build Soroban contracts ──────────────────────────────────────────
if [ "$SKIP_CONTRACTS" = false ]; then
  info "Step 8/10 — Building Soroban contracts"

  if [ -f soroban/build.sh ]; then
    (cd soroban && bash build.sh 2>&1 | tail -10) && success "Soroban contracts built" || {
      warn "Contract build failed — Soroban features will be unavailable locally."
    }
  else
    (cd soroban && cargo build --target wasm32-unknown-unknown --release 2>&1 | tail -10) \
      && success "Soroban contracts built" || {
        warn "Contract build failed — Soroban features will be unavailable locally."
      }
  fi
else
  info "Step 8/10 — Soroban contract build skipped (--skip-contracts)"
fi

echo ""

# ── Step 9: local smoke test ──────────────────────────────────────────────────
if [ "$SKIP_SMOKE" = false ]; then
  info "Step 9/10 — Running local smoke test"

  node scripts/smoke-local.mjs && success "Local smoke test passed" || {
    warn "Smoke test reported failures — review output above."
  }
else
  info "Step 9/10 — Smoke test skipped (--skip-smoke)"
fi

echo ""

# ── Step 10: summary ──────────────────────────────────────────────────────────
info "Step 10/10 — Bootstrap complete"

echo ""
echo -e "${BOLD}=================================================="
echo " Bootstrap Summary"
echo -e "==================================================${RESET}"
echo ""
echo -e "  ${GREEN}App URL:${RESET}         http://localhost:3000"
echo -e "  ${GREEN}MongoDB:${RESET}         mongodb://localhost:27017/eduvault"
echo ""
echo -e "  ${BOLD}Seed accounts (local dev only — do not use in production):${RESET}"
echo ""
echo -e "  ${CYAN}Creators:${RESET}"
echo "    • creator-alice@eduvault.local  (wallet: GCREATOR_ALICE_LOCAL_SEED)"
echo "    • creator-bob@eduvault.local    (wallet: GCREATOR_BOB_LOCAL_SEED)"
echo "    • creator-carol@eduvault.local  (wallet: GCREATOR_CAROL_LOCAL_SEED)"
echo ""
echo -e "  ${CYAN}Buyers:${RESET}"
echo "    • buyer-dave@eduvault.local     (wallet: GBUYER_DAVE_LOCAL_SEED)"
echo "    • buyer-eve@eduvault.local      (wallet: GBUYER_EVE_LOCAL_SEED)"
echo "    • buyer-frank@eduvault.local    (wallet: GBUYER_FRANK_LOCAL_SEED)"
echo ""
echo -e "  ${CYAN}Materials seeded:${RESET} 6 (2 per creator, varied price/visibility)"
echo -e "  ${CYAN}Purchases seeded:${RESET} 3 (one per buyer, active entitlement)"
echo -e "  ${CYAN}Refunds seeded:${RESET}   2 (one pending, one completed)"
echo ""
echo -e "  ${BOLD}Next steps:${RESET}"
echo "    1. npm run dev                   — start the development server"
echo "    2. npm test                      — run the Vitest test suite"
echo "    3. cd soroban && cargo test      — run Soroban contract tests"
echo "    4. bash scripts/smoke-test.sh    — run the post-deploy smoke test"
echo ""
echo -e "${GREEN}Local environment is ready.${RESET}"
echo ""
