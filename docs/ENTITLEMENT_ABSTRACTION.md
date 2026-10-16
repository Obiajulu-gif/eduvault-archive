# Chain-Agnostic Entitlement Abstraction

EduVault defines a chain-agnostic entitlement abstraction (`EntitlementProvider`) that decouples application access control from underlying blockchain implementations.

## Architecture

```
                       +-------------------------+
                       |  authorizeMaterialAccess|
                       +------------+------------+
                                    |
                                    v
                       +-------------------------+
                       | getEntitlementProvider  |
                       +------------+------------+
                                    |
            +-----------------------+-----------------------+
            |                                               |
            v                                               v
+-----------------------+                       +-----------------------+
|EvmEntitlementProvider |                       |SorobanEntitlementProvider
+-----------------------+                       +-----------------------+
| - EVM Event Logs      |                       | - Soroban ContractData|
| - Block Confirmations |                       | - Ledger Close        |
+-----------------------+                       +-----------------------+
```

## Abstract Interface

```javascript
class EntitlementProvider {
  async checkAccess({ walletAddress, materialId, chain, material, db });
  async grantAccess({ walletAddress, materialId, chain, txHash, db });
  async revokeAccess({ walletAddress, materialId, chain, reason, db });
}
```

## Adding New Chains

To support a new chain backend:
1. Extend `EntitlementProvider`.
2. Register the provider in `src/lib/entitlement/factory.js`.
