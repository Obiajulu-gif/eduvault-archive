import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CartProvider, useCart } from '../CartProvider';

const { mockExecute, mockCreatePurchase } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockCreatePurchase: vi.fn(),
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ show: vi.fn() }),
}));

vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ isConnected: true, address: 'GBUYER' }),
}));

vi.mock('@/providers/TransactionProvider', () => ({
  useTransactionCenter: () => ({
    beginTransaction: vi.fn(),
    failTransaction: vi.fn(),
  }),
}));

vi.mock('@/hooks/useStellarTransaction', () => ({
  useStellarTransaction: () => ({ execute: mockExecute }),
}));

vi.mock('@/lib/stellar/purchaseXdr', () => ({
  buildPurchaseTransactionXdr: vi.fn().mockResolvedValue('unsigned-xdr'),
}));

vi.mock('@/services/purchaseService', () => ({
  purchaseService: {
    createPurchase: mockCreatePurchase,
  },
}));

function Harness() {
  const { addToCart, checkout } = useCart();
  return (
    <>
      <button type="button" onClick={() => addToCart({ id: 'mat-1', title: 'Algebra', price: 2 })}>
        add
      </button>
      <button type="button" onClick={() => checkout('buyer@example.com')}>
        checkout
      </button>
    </>
  );
}

describe('CartProvider checkout', () => {
  it('records purchases only with a confirmed Stellar transaction hash', async () => {
    mockExecute.mockResolvedValue({ hash: 'real-stellar-hash' });
    mockCreatePurchase
      .mockResolvedValueOnce({ quoteId: 'quote-1', price: 2, asset: 'XLM' })
      .mockResolvedValueOnce({ success: true });

    render(
      <CartProvider>
        <Harness />
      </CartProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'add' }));
    await userEvent.click(screen.getByRole('button', { name: 'checkout' }));

    await waitFor(() => expect(mockCreatePurchase).toHaveBeenCalledTimes(2));
    expect(mockExecute).toHaveBeenCalledWith('unsigned-xdr', expect.objectContaining({
      description: 'Purchase Algebra',
    }));
    expect(mockCreatePurchase).toHaveBeenCalledWith(expect.objectContaining({
      transactionHash: 'real-stellar-hash',
      quoteId: 'quote-1',
    }));
    expect(mockCreatePurchase.mock.calls[1][0].transactionHash).not.toMatch(/^simulated_/);
  });
});
