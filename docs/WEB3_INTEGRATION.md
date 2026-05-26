# Wallet and Blockchain Integration Status

## Summary

EduVault currently includes an EVM-based wallet and contract prototype. That implementation was useful for validating user flows, but it is not the intended long-term blockchain direction for the Drip Wave submission.

The strategic direction for this project is Stellar-native settlement and entitlement logic built on Soroban.

## What Exists Today

- wallet connection flow in the frontend
- wallet-linked profile creation
- upload flow that pins files and metadata to IPFS
- archived ERC-721 ownership experiment in `archive/legacy-evm/contracts/EduVault.sol`
- marketplace and purchase UI prototypes

## Why the Current Chain Layer Is Not Final

The product need is payment and access control for educational materials. That requires:

- low-cost transactions
- support for small purchase sizes
- strong cross-border usability
- asset flexibility for stable payments and later institutional credits

Those requirements map better to Stellar than to an NFT-first implementation.

## Planned Stellar Integration

### Wallet and auth

- connect a Stellar-compatible wallet
- use account-based signing for purchases and listing actions
- support challenge-based auth where appropriate

### Contracts

- register materials and rights terms on Soroban
- accept payment in XLM or approved Stellar assets
- record entitlements so access can be verified by the application

### Assets

- accept XLM for simple settlement
- accept USDC on Stellar for stable pricing
- optionally support creator-issued or institution-issued access credits

## Migration Principle

The existing web application remains useful. The migration mostly affects the chain layer:

- wallet provider changes
- transaction construction and signing
- entitlement verification
- payout handling

File storage, metadata flow, dashboard UX, and catalog search can be retained with limited changes.

## Documentation Rule

When discussing EduVault externally:

- describe the current repository as a working prototype
- describe Stellar payments and Soroban contracts as the next implementation milestone
- avoid implying that the archived Celo/EVM prototype is already Stellar-native
