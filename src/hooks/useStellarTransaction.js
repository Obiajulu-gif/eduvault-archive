/**
 * useStellarTransaction — Issue #62
 *
 * Hook that composes wallet signing + Stellar RPC submission into a single
 * call. Provides a typed state machine (idle → signing → submitting →
 * success | error) for the checkout and material-registration UIs to
 * display progress feedback to the user.
 *
 * Usage:
 *   const { execute, state, reset } = useStellarTransaction();
 *
 *   // In a button handler:
 *   await execute(unsignedXdr, { description: 'Purchase material' });
 *
 *   // Render feedback:
 *   {state.status === 'signing'    && <p>Approve in your wallet…</p>}
 *   {state.status === 'submitting' && <p>Broadcasting transaction…</p>}
 *   {state.status === 'success'    && <p>Done! Tx: {state.hash}</p>}
 *   {state.status === 'error'      && <p>Error: {state.error.message}</p>}
 */

'use client';

import { useCallback, useState } from 'react';
import { useWallet } from '@/hooks/useWallet';

const STELLAR_RPC_URL =
  process.env.NEXT_PUBLIC_STELLAR_RPC_URL ??
  'https://soroban-testnet.stellar.org';

// ── Status constants ───────────────────────────────────────────────────────────

export const TxStatus = Object.freeze({
  Idle: 'idle',
  Signing: 'signing',
  Submitting: 'submitting',
  Success: 'success',
  Error: 'error',
});

// ── Stellar RPC helpers ───────────────────────────────────────────────────────

async function sendTransaction(signedXdr) {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'sendTransaction',
    params: { transaction: signedXdr },
  };

  const res = await fetch(STELLAR_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  const payload = await res.json();
  if (payload.error) {
    throw new Error(payload.error.message ?? 'sendTransaction failed');
  }

  const { status, hash, errorResultXdr } = payload.result ?? {};
  if (status === 'ERROR') {
    throw new Error(`Transaction rejected: ${errorResultXdr ?? 'unknown error'}`);
  }

  return { hash, status };
}

/**
 * Poll `getTransaction` until the transaction is confirmed or fails.
 * Times out after ~30 s (15 attempts × 2 s).
 */
async function pollTransaction(hash, { maxAttempts = 15, delayMs = 2_000 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, delayMs));

    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: { hash },
    };

    const res = await fetch(STELLAR_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    const payload = await res.json();
    if (payload.error) continue;

    const { status, resultXdr } = payload.result ?? {};

    if (status === 'SUCCESS') return { hash, status, resultXdr };
    if (status === 'FAILED') {
      throw new Error(`Transaction failed on-chain: ${resultXdr ?? 'no detail'}`);
    }
    // status === 'NOT_FOUND' or 'PENDING' — keep polling
  }

  throw new Error('Transaction confirmation timed out');
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * @returns {{
 *   execute: (xdr: string, opts?: { description?: string }) => Promise<{ hash: string }>
 *   state:   { status: string, hash?: string, error?: Error, description?: string }
 *   reset:   () => void
 * }}
 */
export function useStellarTransaction() {
  const { signTransaction, isConnected } = useWallet();
  const [state, setState] = useState({ status: TxStatus.Idle });

  const reset = useCallback(() => setState({ status: TxStatus.Idle }), []);

  const execute = useCallback(
    async (unsignedXdr, { description = 'Transaction' } = {}) => {
      if (!isConnected) {
        throw new Error('Wallet not connected. Please connect your Stellar wallet first.');
      }

      try {
        // ── Signing ────────────────────────────────────────────────────────────
        setState({ status: TxStatus.Signing, description });
        let signedXdr;
        try {
          signedXdr = await signTransaction(unsignedXdr);
        } catch (err) {
          const msg = err?.message ?? String(err);
          const isDismissal = /clos|cancel|reject|dismiss/i.test(msg);
          throw Object.assign(
            new Error(isDismissal ? 'Transaction cancelled in wallet' : msg),
            { dismissed: isDismissal }
          );
        }

        // ── Submission ────────────────────────────────────────────────────────
        setState({ status: TxStatus.Submitting, description });
        const { hash } = await sendTransaction(signedXdr);

        // ── Confirmation polling ──────────────────────────────────────────────
        const confirmed = await pollTransaction(hash);

        setState({ status: TxStatus.Success, hash: confirmed.hash, description });
        return { hash: confirmed.hash };
      } catch (err) {
        setState({
          status: TxStatus.Error,
          error: err instanceof Error ? err : new Error(String(err)),
          description,
        });
        throw err;
      }
    },
    [isConnected, signTransaction]
  );

  return { execute, state, reset };
}
