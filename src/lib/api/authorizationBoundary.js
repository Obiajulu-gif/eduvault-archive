/**
 * Backend ↔ contract authorization boundary — Issue #683.
 *
 * Contract entrypoints authorize callers by wallet address (creator, upgrade
 * admin, or the purchasing buyer). The API layer must map those contract auth
 * failures onto stable HTTP/error shapes instead of leaking raw contract
 * codes, and -- critically -- prove via negative tests that unauthorized
 * creators and buyers cannot publish, update, purchase, refund, or access
 * resources.
 *
 * This module centralizes that mapping:
 *   - `mapContractAuthError` turns a contract `PurchaseError`/`RegistryError`
 *     code into a stable API `{ error, statusCode }` shape.
 *   - `assertResourceOwner` / `assertBuyer` are policy checkers used by route
 *     handlers before delegating to a contract call, so the API fails closed
 *     with the same right shape whether the rejection happens off-chain or
 *     on-chain.
 */

/** Contract authorization/denial codes that must never surface raw. */
const CONTRACT_AUTH_FAILURES = new Set([
  'NotAuthorized',
  'NotFound',
  'MaterialNotFound',
  'EscrowNotFound',
  'NoActiveDispute',
  'NotInitialized',
  'AlreadyInitialized',
]);

/**
 * Map a contract auth/state failure to a stable API error shape.
 *
 * @param {object} params
 * @param {string} params.code - e.g. 'NotAuthorized' | 'MaterialNotFound'
 * @param {string} [params.action] - human-readable action that was denied
 * @returns {{ error: string, statusCode: number }}
 */
export function mapContractAuthError({ code, action = 'this action' }) {
  const normalized = String(code || '');
  if (normalized === 'NotAuthorized' || normalized === 'NotFound') {
    return {
      error: `You are not authorized to ${action}`,
      statusCode: 403,
    };
  }
  if (normalized === 'NotInitialized') {
    return { error: 'Resource is not initialized', statusCode: 503 };
  }
  if (normalized === 'AlreadyInitialized') {
    return { error: 'Resource is already initialized', statusCode: 409 };
  }
  if (CONTRACT_AUTH_FAILURES.has(normalized)) {
    return { error: `Contract rejected ${action}`, statusCode: 403 };
  }
  return { error: `Contract rejected ${action}`, statusCode: 400 };
}

/**
 * Fail-closed owner boundary check. Returns an API error shape when `caller`
 * is neither the resource owner nor the platform upgrade admin; otherwise
 * returns null (authorized).
 *
 * @param {object} params
 * @param {string} params.caller - caller wallet address
 * @param {string} params.owner - the resource's creator/owner address
 * @param {string} params.upgradeAdmin - platform admin address
 * @param {string} [params.action]
 * @returns {null | { error: string, statusCode: number }}
 */
export function assertResourceOwner({ caller, owner, upgradeAdmin, action = 'modify this resource' }) {
  if (!caller) return { error: 'Unauthorized: Wallet connection required', statusCode: 401 };
  const c = String(caller).trim().toLowerCase();
  if (c === String(owner || '').trim().toLowerCase()) return null;
  if (upgradeAdmin && c === String(upgradeAdmin).trim().toLowerCase()) return null;
  return { error: `You are not authorized to ${action}`, statusCode: 403 };
}

/**
 * Fail-closed buyer boundary check. Returns an API error shape when `caller`
 * is not the recorded buyer for the resource; otherwise null (authorized).
 *
 * @param {object} params
 * @param {string} params.caller - caller wallet address
 * @param {string} params.buyer - the buyer's recorded address
 * @param {string} [params.action]
 * @returns {null | { error: string, statusCode: number }}
 */
export function assertBuyer({ caller, buyer, action = 'access this resource' }) {
  if (!caller) return { error: 'Unauthorized: Wallet connection required', statusCode: 401 };
  const c = String(caller).trim().toLowerCase();
  if (c === String(buyer || '').trim().toLowerCase()) return null;
  return { error: `You are not authorized to ${action}`, statusCode: 403 };
}