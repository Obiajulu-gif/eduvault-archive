import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PayoutSplits from '../PayoutSplits';

describe('PayoutSplits Accessibility', () => {
  it('renders accessible inputs with aria-labels and error associations', () => {
    render(<PayoutSplits onChange={vi.fn()} initialSplits={[{ address: 'GB7Y...', percentage: 100 }]} />);

    const addressInput = screen.getByLabelText(/co-author 1 stellar wallet address/i);
    expect(addressInput).toBeInTheDocument();

    const percentageInput = screen.getByLabelText(/co-author 1 payout percentage/i);
    expect(percentageInput).toBeInTheDocument();

    const removeBtn = screen.getByRole('button', { name: /remove co-author split 1/i });
    expect(removeBtn).toBeInTheDocument();
  });

  it('allows adding a co-author split with accessible button', () => {
    render(<PayoutSplits onChange={vi.fn()} />);

    const addBtn = screen.getByRole('button', { name: /add co-author revenue split/i });
    expect(addBtn).toBeInTheDocument();
    fireEvent.click(addBtn);

    const secondAddressInput = screen.getByLabelText(/co-author 2 stellar wallet address/i);
    expect(secondAddressInput).toBeInTheDocument();
  });
});
