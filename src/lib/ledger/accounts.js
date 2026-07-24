/**
 * Chart of accounts for the double-entry ledger.
 *
 * Each account has a type that fixes its "normal" side. Asset and expense
 * accounts increase on the debit side; liability, revenue, and equity accounts
 * increase on the credit side. A signed account balance is therefore
 * `debits - credits` for normal-debit accounts and `credits - debits` for
 * normal-credit accounts.
 */

export const ACCOUNT_TYPES = Object.freeze({
  ASSET: "asset",
  LIABILITY: "liability",
  REVENUE: "revenue",
  EXPENSE: "expense",
  EQUITY: "equity",
});

export const ACCOUNTS = Object.freeze({
  /** Cash received/held via Stellar settlement. */
  SETTLEMENT: "settlement",
  /** Proceeds owed to a creator (per-creator subaccount). */
  CREATOR_PAYABLE: "creator_payable",
  /** Platform fee income. */
  PLATFORM_FEE_REVENUE: "platform_fee_revenue",
  /** Amounts owed back to buyers pending refund settlement. */
  REFUNDS_PAYABLE: "refunds_payable",
  /** Discounts the platform absorbs. */
  PLATFORM_DISCOUNT_EXPENSE: "platform_discount_expense",
});

const NORMAL_SIDE = Object.freeze({
  [ACCOUNTS.SETTLEMENT]: ACCOUNT_TYPES.ASSET,
  [ACCOUNTS.CREATOR_PAYABLE]: ACCOUNT_TYPES.LIABILITY,
  [ACCOUNTS.PLATFORM_FEE_REVENUE]: ACCOUNT_TYPES.REVENUE,
  [ACCOUNTS.REFUNDS_PAYABLE]: ACCOUNT_TYPES.LIABILITY,
  [ACCOUNTS.PLATFORM_DISCOUNT_EXPENSE]: ACCOUNT_TYPES.EXPENSE,
});

/** Return the account type, or throw for an unknown account. */
export function accountType(account) {
  const type = NORMAL_SIDE[account];
  if (!type) {
    throw new Error(`Unknown ledger account: ${account}`);
  }
  return type;
}

/** True when the account increases on the debit side. */
export function isNormalDebit(account) {
  const type = accountType(account);
  return type === ACCOUNT_TYPES.ASSET || type === ACCOUNT_TYPES.EXPENSE;
}
