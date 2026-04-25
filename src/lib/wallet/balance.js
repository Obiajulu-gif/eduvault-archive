import { horizon } from './kit';

export const BalancesStatus = Object.freeze({
  Idle: 'idle',           
  Loading: 'loading',
  Loaded: 'loaded',
  Unfunded: 'unfunded', 
  Error: 'error',
});

export async function fetchBalances(address) {
  let account;
  try {
    account = await horizon.loadAccount(address);
  } catch (err) {
    console.error('Error loading account details', err);
    const status = err?.response?.status ?? err?.status;
    const name = err?.name ?? '';
    if (status === 404 || name === 'NotFoundError') {
      return { status: 'unfunded' };
    }
    throw err;
  }

  const balances = account.balances.map((b) => ({
    assetType: b.asset_type,
    balance: b.balance,
    assetCode: b.asset_code,
    assetIssuer: b.asset_issuer,
    liquidityPoolId: b.liquidity_pool_id,
  }));

  const native =
    balances.find((b) => b.assetType === 'native') ??
    { assetType: 'native', balance: '0' };

  return {
    status: 'loaded',
    snapshot: { balances, native },
  };
}

export function findAssetBalance(balances, code, issuer) {
  const hit = balances.find(
    (b) =>
      (b.assetType === 'credit_alphanum4' || b.assetType === 'credit_alphanum12') &&
      b.assetCode === code &&
      b.assetIssuer === issuer,
  );
  return hit ? hit.balance : '0';
}