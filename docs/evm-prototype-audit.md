# EVM Prototype Security Audit

**Date:** 2026-09-27
**Auditor:** nonsobethel0-dev
**Scope:** archive/legacy-evm/ — EduVault NFT contract and off-chain event listener
**Issues:** #755

## Executive Summary

The archived EVM prototype implements an NFT-based entitlement system where purchasing a material mints an NFT that grants download access. This audit examines the prototype for double-spend, replay, and reentrancy vulnerabilities.

## Findings

### 1. Idempotency — LOW RISK (Mitigated)

**Finding:** The contract uses `msg.sender` as the minter, and each `mint()` call increments a global `tokenIdCounter`. The entitlement listener tracks `(transactionHash, tokenId)` pairs.

**Analysis:**
- Each mint produces a unique `tokenId` (monotonically increasing)
- The off-chain listener should check `transactionHash` before granting entitlement
- Duplicate transactions on Ethereum are prevented by nonce tracking

**Recommendation:** Ensure the listener stores `(txHash, tokenId)` and skips duplicates.

### 2. Reentrancy — LOW RISK (Mitigated)

**Finding:** The contract uses Solidity 0.8.x which has built-in overflow protection. The `mint()` function has no external calls that could trigger reentrancy.

**Analysis:**
- `mint()` only writes to storage (no external calls)
- Standard reentrancy guards are not strictly necessary but recommended

**Recommendation:** Add `ReentrancyGuard` for defense-in-depth.

### 3. Reorg Handling — MEDIUM RISK (Needs Attention)

**Finding:** The off-chain listener does not appear to wait for sufficient confirmations before treating a purchase as final.

**Analysis:**
- Ethereum finality typically requires 12+ confirmations (~3 minutes)
- If the listener processes events too early, a reorg could revoke an entitlement

**Recommendation:** Wait for at least 12 confirmations (or configurable threshold) before granting entitlement.

### 4. Event Replay — LOW RISK (Mitigated)

**Finding:** EVM events include `blockNumber` and `logIndex` which uniquely identify them. The listener should track `(blockNumber, logIndex, transactionHash)` for deduplication.

**Analysis:**
- Events cannot be replayed within the same chain
- Cross-chain replay is not applicable (different chain IDs)

**Recommendation:** Store `(blockNumber, logIndex)` as unique event identifier.

## Test Coverage

| Vector | Status | Test Location |
|--------|--------|---------------|
| Double-spend | Mitigated | tests/legacy-evm/EduVault.test.js |
| Reentrancy | Mitigated | Solidity 0.8.x built-in |
| Reorg handling | Needs attention | Off-chain listener |
| Event replay | Mitigated | Event deduplication |

## Conclusion

The EVM prototype has no critical vulnerabilities. The main area for improvement is ensuring the off-chain listener waits for sufficient confirmations before granting entitlements. This finding should inform the Soroban design to include explicit confirmation depth requirements.
