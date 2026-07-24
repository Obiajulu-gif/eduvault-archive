/**
 * Immutable double-entry ledger with Stellar reconciliation.
 *
 * Public entry point for the accounting subsystem (issue #28). See
 * `docs/accounting/LEDGER.md` for the design, invariants, and integration plan.
 */

export * from "./money.js";
export * from "./accounts.js";
export * from "./journal.js";
export * from "./postingRules.js";
export * from "./balances.js";
export * from "./reconciliation.js";
export * from "./backfill.js";
export * from "./period.js";
export { InMemoryLedgerRepository } from "./repository/memory.js";
export { MongoLedgerRepository, LEDGER_COLLECTIONS } from "./repository/mongo.js";
export {
  ledgerRepository,
  ensureLedgerIndexes,
  recordPurchase,
  recordRefund,
  recordRefundSettlement,
  recordReversal,
} from "./service.js";
