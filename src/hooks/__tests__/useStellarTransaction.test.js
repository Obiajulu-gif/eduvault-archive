import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useStellarTransaction, TxStatus } from '../useStellarTransaction';
import { useWallet } from '@/hooks/useWallet';
import { useTransactionCenter } from '@/providers/TransactionProvider';
import { TransactionStatus } from '@/lib/transactions/transaction';

vi.mock('@/hooks/useWallet', () => ({
  useWallet: vi.fn(),
}));

vi.mock('@/providers/TransactionProvider', () => ({
  useTransactionCenter: vi.fn(),
}));

vi.mock('@/lib/config/chain', () => ({
  STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
  NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
}));

describe('useStellarTransaction hook', () => {
  let mockWallet;
  let mockTxCenter;
  let originalFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = global.fetch;

    mockWallet = {
      isConnected: true,
      address: 'GDUMMY7TESTWALLETADDRESSFORVITEST0000000000000000000000',
      signTransaction: vi.fn().mockResolvedValue('AAAA_SIGNED_XDR_SAMPLE'),
    };
    useWallet.mockImplementation(() => mockWallet);

    mockTxCenter = {
      beginTransaction: vi.fn(),
      markStatus: vi.fn(),
      confirmTransaction: vi.fn(),
      failTransaction: vi.fn(),
      retryTransaction: vi.fn(),
      clearTransaction: vi.fn(),
    };
    useTransactionCenter.mockImplementation(() => mockTxCenter);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  describe('Initial State & Reset', () => {
    it('initializes with Idle status and helper methods', () => {
      const { result } = renderHook(() => useStellarTransaction());

      expect(result.current.state.status).toBe(TxStatus.Idle);
      expect(typeof result.current.execute).toBe('function');
      expect(typeof result.current.reset).toBe('function');
      expect(typeof result.current.retry).toBe('function');
      expect(typeof result.current.buildExplorerUrl).toBe('function');
    });

    it('resets state back to Idle and clears transaction center', () => {
      const { result } = renderHook(() => useStellarTransaction());

      act(() => {
        result.current.reset();
      });

      expect(result.current.state.status).toBe(TxStatus.Idle);
      expect(mockTxCenter.clearTransaction).toHaveBeenCalled();
    });

    it('delegates retry action to transaction center', () => {
      const { result } = renderHook(() => useStellarTransaction());

      act(() => {
        result.current.retry({ message: 'Retrying now' });
      });

      expect(mockTxCenter.retryTransaction).toHaveBeenCalledWith({ message: 'Retrying now' });
    });
  });

  describe('Wallet Connection Guard', () => {
    it('rejects immediately when isConnected is false and never calls signTransaction', async () => {
      mockWallet.isConnected = false;
      const { result } = renderHook(() => useStellarTransaction());

      let caughtError;
      await act(async () => {
        try {
          await result.current.execute('AAAA_UNSIGNED_XDR', { description: 'Mint NFT' });
        } catch (err) {
          caughtError = err;
        }
      });

      expect(caughtError).toBeDefined();
      expect(caughtError.message).toMatch(/wallet not connected/i);
      expect(mockWallet.signTransaction).not.toHaveBeenCalled();
      expect(result.current.state.status).toBe(TxStatus.WaitingWallet);
      expect(result.current.state.description).toBe('Mint NFT');

      expect(mockTxCenter.beginTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'stellar',
          title: 'Mint NFT',
        })
      );
      expect(mockTxCenter.failTransaction).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          status: TransactionStatus.NeedsRetry,
          retryable: true,
        })
      );
    });
  });

  describe('Wallet Rejection & Dismissal Classification (/clos|cancel|reject|dismiss/i)', () => {
    const realWorldDismissalSamples = [
      { name: 'Freighter rejection', msg: 'User rejected the request' },
      { name: 'Freighter cancellation', msg: 'User cancelled transaction' },
      { name: 'Albedo cancel', msg: 'Request canceled by user' },
      { name: 'Generic dismiss', msg: 'User dismissed signature modal' },
      { name: 'Freighter extension reject', msg: 'Transaction rejected in Freighter' },
      { name: 'Albedo popup close', msg: 'Popup closed by user' },
      { name: 'Window close event', msg: 'User closed the authorization window' },
      { name: 'Dismissed by wallet', msg: 'Signing request dismissed' },
    ];

    realWorldDismissalSamples.forEach(({ name, msg }) => {
      it(`classifies ${name} ("${msg}") as NeedsRetry with dismissed: true`, async () => {
        mockWallet.signTransaction.mockRejectedValue(new Error(msg));
        const { result } = renderHook(() => useStellarTransaction());

        let caughtError;
        await act(async () => {
          try {
            await result.current.execute('AAAA_UNSIGNED_XDR', { description: 'Purchase Material' });
          } catch (err) {
            caughtError = err;
          }
        });

        expect(caughtError).toBeDefined();
        expect(caughtError.dismissed).toBe(true);
        expect(result.current.state.status).toBe(TxStatus.NeedsRetry);
        expect(result.current.state.error.dismissed).toBe(true);

        expect(mockTxCenter.failTransaction).toHaveBeenCalledWith(
          expect.objectContaining({ dismissed: true }),
          expect.objectContaining({
            status: TransactionStatus.NeedsRetry,
            title: 'Signature rejected',
            retryable: true,
          })
        );
      });
    });

    it('classifies non-dismissal signing failure as hard Error (dismissed: false)', async () => {
      const genuineError = 'Hardware device communication broken: invalid public key bytes';
      mockWallet.signTransaction.mockRejectedValue(new Error(genuineError));
      const { result } = renderHook(() => useStellarTransaction());

      let caughtError;
      await act(async () => {
        try {
          await result.current.execute('AAAA_UNSIGNED_XDR');
        } catch (err) {
          caughtError = err;
        }
      });

      expect(caughtError).toBeDefined();
      expect(caughtError.dismissed).toBe(false);
      expect(result.current.state.status).toBe(TxStatus.Error);
      expect(result.current.state.error.message).toBe(genuineError);

      expect(mockTxCenter.failTransaction).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          status: TransactionStatus.Failed,
          title: 'Transaction failed',
        })
      );
    });
  });

  describe('RPC sendTransaction & Submission Failures', () => {
    it('surfaces error when sendTransaction returns RPC payload error', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => ({
          error: { message: 'Soroban RPC endpoint down' },
        }),
      });

      const { result } = renderHook(() => useStellarTransaction());

      let caughtError;
      await act(async () => {
        try {
          await result.current.execute('AAAA_UNSIGNED_XDR');
        } catch (err) {
          caughtError = err;
        }
      });

      expect(caughtError).toBeDefined();
      expect(caughtError.message).toBe('Soroban RPC endpoint down');
      expect(result.current.state.status).toBe(TxStatus.NeedsRetry); // classified as network issue
    });

    it('surfaces error with errorResultXdr when status is ERROR', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => ({
          result: {
            status: 'ERROR',
            errorResultXdr: 'AAAA_TX_SUBMISSION_FAILED_XDR',
          },
        }),
      });

      const { result } = renderHook(() => useStellarTransaction());

      let caughtError;
      await act(async () => {
        try {
          await result.current.execute('AAAA_UNSIGNED_XDR');
        } catch (err) {
          caughtError = err;
        }
      });

      expect(caughtError).toBeDefined();
      expect(caughtError.message).toContain('Transaction rejected: AAAA_TX_SUBMISSION_FAILED_XDR');
      // The message contains "rejected", so classifyTransactionError classifies as NeedsRetry
      expect(result.current.state.status).toBe(TxStatus.NeedsRetry);
      expect(mockTxCenter.failTransaction).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          status: TransactionStatus.NeedsRetry,
          title: 'Signature rejected',
          retryable: true,
        })
      );
    });

    it('surfaces fallback error when status is ERROR without errorResultXdr', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        json: async () => ({
          result: {
            status: 'ERROR',
          },
        }),
      });

      const { result } = renderHook(() => useStellarTransaction());

      let caughtError;
      await act(async () => {
        try {
          await result.current.execute('AAAA_UNSIGNED_XDR');
        } catch (err) {
          caughtError = err;
        }
      });

      expect(caughtError).toBeDefined();
      expect(caughtError.message).toContain('Transaction rejected: unknown error');
    });
  });

  describe('RPC pollTransaction & Confirmation States', () => {
    it('throws when on-chain status is FAILED with resultXdr details', async () => {
      vi.useFakeTimers();

      global.fetch = vi
        .fn()
        // sendTransaction response
        .mockResolvedValueOnce({
          json: async () => ({
            result: { status: 'PENDING', hash: 'tx-hash-failed-123' },
          }),
        })
        // pollTransaction getTransaction response
        .mockResolvedValueOnce({
          json: async () => ({
            result: {
              status: 'FAILED',
              resultXdr: 'CONTRACT_PANIC_INVALID_AUTH',
            },
          }),
        });

      const { result } = renderHook(() => useStellarTransaction());

      let caughtError;
      act(() => {
        result.current.execute('AAAA_UNSIGNED_XDR').catch((err) => {
          caughtError = err;
        });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(caughtError).toBeDefined();
      expect(caughtError.message).toContain('Transaction failed on-chain: CONTRACT_PANIC_INVALID_AUTH');
      expect(result.current.state.status).toBe(TxStatus.Error);
      expect(mockTxCenter.failTransaction).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          status: TransactionStatus.Failed,
          title: 'Transaction failed',
        })
      );
    });

    it('throws timeout error when maxAttempts are exhausted without confirmation', async () => {
      vi.useFakeTimers();

      global.fetch = vi
        .fn()
        // sendTransaction response
        .mockResolvedValueOnce({
          json: async () => ({
            result: { status: 'PENDING', hash: 'tx-hash-timeout-123' },
          }),
        })
        // getTransaction always returns pending until attempts exhausted
        .mockResolvedValue({
          json: async () => ({
            result: { status: 'PENDING' },
          }),
        });

      const { result } = renderHook(() => useStellarTransaction());

      let caughtError;
      act(() => {
        result.current.execute('AAAA_UNSIGNED_XDR').catch((err) => {
          caughtError = err;
        });
      });

      // Advance through all 15 polling attempts (15 * 2000ms = 30000ms)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(35000);
      });

      expect(caughtError).toBeDefined();
      expect(caughtError.message).toMatch(/Transaction confirmation timed out/);
      expect(result.current.state.status).toBe(TxStatus.NeedsRetry);
      expect(mockTxCenter.failTransaction).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          status: TransactionStatus.NeedsRetry,
          title: 'Confirmation timed out',
          retryable: true,
        })
      );
    });
  });

  describe('Full Successful State Lifecycle', () => {
    it('transitions through Signing -> Submitting -> PendingConfirmation -> Success', async () => {
      vi.useFakeTimers();

      const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const resultXdr = 'AAAA_SUCCESS_RESULT_XDR';

      global.fetch = vi
        .fn()
        // sendTransaction
        .mockResolvedValueOnce({
          json: async () => ({
            result: { status: 'PENDING', hash: txHash },
          }),
        })
        // pollTransaction getTransaction
        .mockResolvedValueOnce({
          json: async () => ({
            result: { status: 'SUCCESS', resultXdr },
          }),
        });

      const { result } = renderHook(() => useStellarTransaction());

      let executeOutcome;
      act(() => {
        result.current
          .execute('AAAA_UNSIGNED_XDR', {
            description: 'Register Material on Soroban',
          })
          .then((res) => {
            executeOutcome = res;
          });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(executeOutcome).toEqual({ hash: txHash });
      expect(result.current.state.status).toBe(TxStatus.Success);
      expect(result.current.state.hash).toBe(txHash);
      expect(result.current.state.description).toBe('Register Material on Soroban');

      // Verify transaction center tracking calls
      expect(mockTxCenter.markStatus).toHaveBeenCalledWith(
        TransactionStatus.Signing,
        expect.objectContaining({
          title: 'Register Material on Soroban - waiting for wallet',
        })
      );
      expect(mockTxCenter.markStatus).toHaveBeenCalledWith(
        TransactionStatus.Submitting,
        expect.objectContaining({
          title: 'Register Material on Soroban - submitting',
        })
      );
      expect(mockTxCenter.markStatus).toHaveBeenCalledWith(
        TransactionStatus.PendingConfirmation,
        expect.objectContaining({
          txHash,
          title: 'Register Material on Soroban - pending confirmation',
        })
      );
      expect(mockTxCenter.confirmTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          txHash,
          title: 'Register Material on Soroban confirmed',
        })
      );
    });
  });
});
