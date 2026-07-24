# Wallet and Blockchain Integration

## Summary

EduVault uses Stellar-native settlement and entitlement logic built on Soroban. The platform utilizes low-cost transactions and supports asset flexibility for stable payments and creator-issued credits.

## What Exists Today

- Stellar wallet connection flow in the frontend
- wallet-linked profile creation
- upload flow that pins files and metadata to IPFS
- Soroban contracts for Material Registry and Purchase Manager
- marketplace and purchase UI

## Stellar Integration

### Wallet and auth

- connect a Stellar-compatible wallet
- use account-based signing for purchases and listing actions
- support challenge-based auth where appropriate

### Contracts

- register materials and rights terms on Soroban (`MaterialRegistry`)
- accept payment in XLM or approved Stellar assets (`PurchaseManager`)
- record entitlements so access can be verified by the application

### Assets

- accept XLM for simple settlement
- accept USDC on Stellar for stable pricing
- optionally support creator-issued or institution-issued access credits

## Documentation Rule

When discussing EduVault externally:

- describe the repository as using Stellar payments and Soroban contracts as the core blockchain implementation
- refer to the legacy EVM architecture only in the context of the migration history (see `migration-erc721-to-soroban.md`)
