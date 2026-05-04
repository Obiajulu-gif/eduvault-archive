#!/bin/bash
# Script to run MaterialRegistry Soroban contract tests

echo "Running MaterialRegistry Soroban Contract Tests..."
echo "=================================================="

cd "$(dirname "$0")" || exit 1

# Check if we're in the right directory
if [ ! -f "Cargo.toml" ]; then
    echo "Error: Cargo.toml not found. Please run this script from the soroban directory."
    exit 1
fi

# Run all tests
echo ""
echo "Running all contract tests..."
cargo test --lib -- --nocapture

# Check test results
if [ $? -eq 0 ]; then
    echo ""
    echo "✓ All tests passed!"
    echo ""
    echo "Test Summary:"
    echo "- Material registration with events"
    echo "- Duplicate quote asset rejection"
    echo "- Invalid payout share sum rejection"
    echo "- Duplicate material ID rejection"
    echo "- Creator authorization requirements"
    echo "- Sale terms updates"
    echo "- Material status changes"
    echo "- Quote lookup functionality"
else
    echo ""
    echo "✗ Tests failed. Please check the output above."
    exit 1
fi
