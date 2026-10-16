# Soroban escrow and payout split

Issue #758 is covered by `soroban/contracts/purchase-manager`. The contract
already uses an escrow-then-release state machine for the checkout boundary:

1. `purchase` validates the material quote, allowlisted asset, amount, sale
   terms, and payout shares;
2. the platform fee is transferred to the configured treasury and the seller
   net is transferred into contract custody;
3. an immutable `EscrowRecord`, entitlement, purchase snapshot, and pending
   settlement are written;
4. after the lock period, an authorized payout recipient calls
   `withdraw_payouts`, which distributes the configured shares and atomically
   marks escrow claimed/released;
5. refund and dispute paths reject claimed/released escrows and revoke the
   entitlement before returning buyer funds.

Native XLM and SAC-wrapped assets use the same `transfer_asset` boundary. An
asset must be explicitly enabled and accepted by the material quote; wrong
assets, wrong amounts, disabled assets, duplicate purchases, and invalid payout
shares fail before funds are moved. Shares are bounded, unique, sum to the
seller net, and include the creator payout.

The relevant contract tests cover native/token allowlisting, payout math,
escrow locking, duplicate release prevention, refund after cancellation, and
authorization. `PayoutDistributedEvent`, `EscrowCreatedEvent`,
`EscrowReleasedEvent`, and `PurchaseRefundedEvent` provide indexer-visible
settlement evidence without exposing secrets. Upgrade/rollback must preserve
the `EscrowRecord` and `SettlementRecord` layout; changes to split semantics
require a new contract version and migration rather than rewriting claimed
escrows.
