import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import BuyNowModal from '../BuyNowModal';

const {
  mockUseAccount,
  mockUseWallet,
  mockUseTransactionCenter,
  mockStartAccessRequest,
  mockCreatePurchase,
  mockRequestQuote,
  mockValidateQuote,
} = vi.hoisted(() => ({
  mockUseAccount: vi.fn(),
  mockUseWallet: vi.fn(),
  mockUseTransactionCenter: vi.fn(),
  mockStartAccessRequest: vi.fn(),
  mockCreatePurchase: vi.fn(),
  mockRequestQuote: vi.fn(),
  mockValidateQuote: vi.fn(),
}));

vi.mock('next/image', () => ({
  default: ({ alt = '' }) => <span role="img" aria-label={alt} />,
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => <>{children}</>,
  motion: {
    div: ({ children, ...rest }) => <div {...rest}>{children}</div>,
  },
}));

vi.mock('wagmi', () => ({
  useAccount: mockUseAccount,
}));

vi.mock('@/hooks/useWallet', () => ({
  useWallet: mockUseWallet,
}));

vi.mock('@/lib/config/assets', () => ({
  getSupportedPaymentAssets: () => [
    { code: 'XLM', label: 'XLM (Stellar Lumens)', requiresTrustline: false },
    { code: 'USDC', label: 'USDC', requiresTrustline: true },
  ],
}));

vi.mock('@/providers/TransactionProvider', () => ({
  useTransactionCenter: mockUseTransactionCenter,
}));

vi.mock('@/hooks/api/usePurchases', () => ({
  useStartAccessRequest: () => ({
    mutateAsync: mockStartAccessRequest,
    isPending: false,
  }),
  useCreatePurchase: () => ({
    mutateAsync: mockCreatePurchase,
    isPending: false,
  }),
}));

vi.mock('@/services/purchaseService', () => ({
  purchaseService: {
    requestQuote: mockRequestQuote,
    validateQuote: mockValidateQuote,
  },
}));

vi.mock('@/components/transactions/TransactionStatusPanel', () => ({
  default: () => <div data-testid="tx-status-panel" />,
}));

vi.mock('../../../../../../components/modals/CheckoutReceiptModal', () => ({
  default: ({ isOpen, status }) =>
    isOpen ? <div data-testid="receipt-modal" data-status={status} /> : null,
}));

vi.mock('../ConnectWalletModal', () => ({
  default: ({ isOpen }) => (isOpen ? <div data-testid="connect-wallet-modal" /> : null),
}));

describe('BuyNowModal - buyer-facing stale-quote detection before signing', () => {
  const futureExpiry = () => new Date(Date.now() + 10 * 60 * 1000).toISOString();

  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAccount.mockReturnValue({ address: null });
    mockUseWallet.mockReturnValue({
      state: { status: 'Connected', session: { address: 'GBUYER123' } },
    });
    mockUseTransactionCenter.mockReturnValue({
      activeTransaction: { status: 'idle', explorerUrl: null },
      beginTransaction: vi.fn(),
      markStatus: vi.fn(),
      confirmTransaction: vi.fn(),
      failTransaction: vi.fn(),
      clearTransaction: vi.fn(),
    });
    mockStartAccessRequest.mockResolvedValue({ ok: true });
    mockCreatePurchase.mockResolvedValue({
      purchase: { transactionHash: 'tx-confirmed', confirmedAt: '2026-11-24T12:00:00.000Z' },
    });
  });

  it('normal path: validates fresh quote before signing and passes quoteId to purchase', async () => {
    mockRequestQuote.mockResolvedValue({
      quoteId: 'quote-fresh-1',
      materialId: 'mat-1',
      buyerAddress: 'GBUYER123',
      price: 10,
      asset: 'XLM',
      expiresAt: futureExpiry(),
    });
    mockValidateQuote.mockResolvedValue({
      fresh: true,
      stale: false,
      quoteId: 'quote-fresh-1',
      materialId: 'mat-1',
      buyerAddress: 'GBUYER123',
      price: 10,
      asset: 'XLM',
      expiresAt: futureExpiry(),
    });

    render(
      <BuyNowModal
        isOpen
        onClose={vi.fn()}
        price={10}
        materialId="mat-1"
        materialTitle="Soroban 101"
        materialCreator="Ada"
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/10\.00 XLM/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Pay and unlock access/i }));

    await waitFor(() => {
      expect(mockValidateQuote).toHaveBeenCalledWith(
        expect.objectContaining({
          materialId: 'mat-1',
          quoteId: 'quote-fresh-1',
          buyerAddress: 'GBUYER123',
        })
      );
    });

    await waitFor(() => {
      expect(mockCreatePurchase).toHaveBeenCalledWith(
        expect.objectContaining({
          materialId: 'mat-1',
          quoteId: 'quote-fresh-1',
        })
      );
    });
  });

  it('stale & retry path: blocks signing when price drifted, then succeeds after buyer refreshes quote', async () => {
    mockRequestQuote
      .mockResolvedValueOnce({
        quoteId: 'quote-old',
        materialId: 'mat-1',
        buyerAddress: 'GBUYER123',
        price: 10,
        asset: 'XLM',
        expiresAt: futureExpiry(),
      })
      .mockResolvedValueOnce({
        quoteId: 'quote-new',
        materialId: 'mat-1',
        buyerAddress: 'GBUYER123',
        price: 14,
        asset: 'XLM',
        expiresAt: futureExpiry(),
      });

    const staleErr = Object.assign(new Error('Listing terms changed'), {
      status: 409,
      data: {
        code: 'CONFLICT_STATE',
        stale: true,
        reason: 'TERMS_CHANGED',
        canRefresh: true,
        changedFields: ['price'],
        quoteTerms: { price: 10, asset: 'XLM' },
        currentTerms: { price: 14, asset: 'XLM' },
      },
    });
    mockValidateQuote
      .mockRejectedValueOnce(staleErr)
      .mockResolvedValueOnce({
        fresh: true,
        stale: false,
        quoteId: 'quote-new',
        materialId: 'mat-1',
        buyerAddress: 'GBUYER123',
        price: 14,
        asset: 'XLM',
        expiresAt: futureExpiry(),
      });

    const { rerender } = render(
      <BuyNowModal
        isOpen
        onClose={vi.fn()}
        price={10}
        materialId="mat-1"
        materialTitle="Soroban 101"
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/10\.00 XLM/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Pay and unlock access/i }));

    const alert = await screen.findByTestId('stale-quote-alert');
    expect(alert).toHaveTextContent(/Price changed before signing/i);
    expect(alert).toHaveTextContent(/10\.00 XLM to 14\.00 XLM/);

    // Signing and purchase must NOT be called when quote is stale
    expect(mockStartAccessRequest).not.toHaveBeenCalled();
    expect(mockCreatePurchase).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Pay and unlock access/i })).toBeDisabled();

    // Buyer refreshes quote (retry path)
    rerender(
      <BuyNowModal
        isOpen
        onClose={vi.fn()}
        price={14}
        materialId="mat-1"
        materialTitle="Soroban 101"
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Refresh quote/i }));

    await waitFor(() => {
      expect(screen.getByText(/14\.00 XLM/)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('stale-quote-alert')).not.toBeInTheDocument();

    // Now buyer explicitly clicks Pay with the refreshed quote
    fireEvent.click(screen.getByRole('button', { name: /Pay and unlock access/i }));

    await waitFor(() => {
      expect(mockCreatePurchase).toHaveBeenCalledWith(
        expect.objectContaining({ quoteId: 'quote-new' })
      );
    });
  });

  it('authorization path: blocks signing and prompts reconnect on 403 wallet mismatch', async () => {
    mockRequestQuote.mockResolvedValue({
      quoteId: 'quote-auth',
      materialId: 'mat-1',
      buyerAddress: 'GBUYER123',
      price: 10,
      asset: 'XLM',
      expiresAt: futureExpiry(),
    });
    const authErr = Object.assign(new Error('Wallet mismatch'), {
      status: 403,
      data: {
        code: 'AUTH_WALLET_MISMATCH',
        error: 'Connected wallet address does not match your authenticated session.',
      },
    });
    mockValidateQuote.mockRejectedValue(authErr);

    render(
      <BuyNowModal
        isOpen
        onClose={vi.fn()}
        price={10}
        materialId="mat-1"
        materialTitle="Soroban 101"
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/10\.00 XLM/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Pay and unlock access/i }));

    const alert = await screen.findByTestId('stale-quote-alert');
    expect(alert).toHaveTextContent(/Wallet authorization mismatch/i);
    expect(screen.getByRole('button', { name: /Reconnect wallet/i })).toBeInTheDocument();
    expect(mockStartAccessRequest).not.toHaveBeenCalled();
    expect(mockCreatePurchase).not.toHaveBeenCalled();
  });

  it('failure & retry path: blocks signing on transient network error and allows retrying verification', async () => {
    mockRequestQuote.mockResolvedValue({
      quoteId: 'quote-net',
      materialId: 'mat-1',
      buyerAddress: 'GBUYER123',
      price: 10,
      asset: 'XLM',
      expiresAt: futureExpiry(),
    });
    mockValidateQuote
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce({
        fresh: true,
        stale: false,
        quoteId: 'quote-net',
        materialId: 'mat-1',
        buyerAddress: 'GBUYER123',
        price: 10,
        asset: 'XLM',
        expiresAt: futureExpiry(),
      });

    render(
      <BuyNowModal
        isOpen
        onClose={vi.fn()}
        price={10}
        materialId="mat-1"
        materialTitle="Soroban 101"
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/10\.00 XLM/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Pay and unlock access/i }));

    const alert = await screen.findByTestId('stale-quote-alert');
    expect(alert).toHaveTextContent(/Could not verify quote/i);
    expect(mockStartAccessRequest).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Retry verification/i }));

    await waitFor(() => {
      expect(mockCreatePurchase).toHaveBeenCalledWith(
        expect.objectContaining({ quoteId: 'quote-net' })
      );
    });
  });
});
