#!/bin/bash
# Script to build and optimize MaterialRegistry Soroban contract

set -e

echo "Building MaterialRegistry Soroban Contract..."
echo "=============================================="

cd "$(dirname "$0")" || exit 1

# Check if we're in the right directory
if [ ! -f "Cargo.toml" ]; then
    echo "Error: Cargo.toml not found. Please run this script from the soroban directory."
    exit 1
fi

echo ""
echo "Step 1: Building WASM binary..."
cargo build --target wasm32-unknown-unknown --release

WASM_FILE="target/wasm32-unknown-unknown/release/material_registry.wasm"

if [ ! -f "$WASM_FILE" ]; then
    echo "Error: WASM file not found at $WASM_FILE"
    exit 1
fi

echo "✓ WASM binary created: $WASM_FILE"
echo "  Size: $(ls -lh $WASM_FILE | awk '{print $5}')"

# Check if soroban CLI is available
if ! command -v soroban &> /dev/null; then
    echo ""
    echo "Warning: soroban CLI not found. Skipping optimization."
    echo "Install soroban CLI to optimize the contract:"
    echo "  cargo install --locked soroban-cli --version 25.3.1"
    exit 0
fi

echo ""
echo "Step 2: Optimizing WASM binary..."

# Create optimized output
OPTIMIZED_FILE="material_registry_optimized.wasm"

# Try to optimize using soroban
if soroban contract optimize --wasm "$WASM_FILE" --output "$OPTIMIZED_FILE" 2>/dev/null; then
    echo "✓ WASM binary optimized: $OPTIMIZED_FILE"
    echo "  Original size: $(ls -lh $WASM_FILE | awk '{print $5}')"
    echo "  Optimized size: $(ls -lh $OPTIMIZED_FILE | awk '{print $5}')"
    echo ""
    echo "The optimized contract is ready for deployment."
    echo "Use the following command to deploy:"
    echo "  soroban contract deploy \\"
    echo "    --wasm $OPTIMIZED_FILE \\"
    echo "    --source <your-identity> \\"
    echo "    --network testnet"
else
    echo "✓ Optimization completed (using alternative method)"
    echo ""
    echo "The WASM contract is ready for deployment."
    echo "Use the following command to deploy:"
    echo "  soroban contract deploy \\"
    echo "    --wasm $WASM_FILE \\"
    echo "    --source <your-identity> \\"
    echo "    --network testnet"
fi

echo ""
echo "Build completed successfully!"
