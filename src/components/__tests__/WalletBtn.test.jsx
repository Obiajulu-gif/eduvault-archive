import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { WalletButton } from '../WalletBtn';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/hooks/useWallet', () => ({
  useWallet: vi.fn(),
}));

vi.mock('@creit-tech/stellar-wallets-kit', () => ({
  StellarWalletsKit: vi.fn().mockImplementation(() => ({})),
  KitEventType: {},
  WalletNetwork: {},
}));

import { useWallet } from '@/hooks/useWallet';
import { WalletStatus } from '@/providers/WalletProvider';

describe('WalletButton Accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should have no violations in Idle state', async () => {
    useWallet.mockReturnValue({
      state: { status: WalletStatus.Idle },
      connect: vi.fn(),
      disconnect: vi.fn(),
    });

    const { container } = render(<WalletButton />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('should have no violations in Connected state', async () => {
    useWallet.mockReturnValue({
      state: {
        status: WalletStatus.Connected,
        session: { address: 'GBDITFOZ3YFSV3G2H3XG5XW2XW2XW2XW2XW2XW2XW2' },
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    });

    const { container } = render(<WalletButton />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('should have no violations in Error state', async () => {
    useWallet.mockReturnValue({
      state: { status: WalletStatus.Error },
      connect: vi.fn(),
      disconnect: vi.fn(),
    });

    const { container } = render(<WalletButton />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('should have no violations in Locked state', async () => {
    useWallet.mockReturnValue({
      state: { status: WalletStatus.Locked },
      connect: vi.fn(),
      disconnect: vi.fn(),
    });

    const { container } = render(<WalletButton />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('should have no violations in Expired state', async () => {
    useWallet.mockReturnValue({
      state: { status: WalletStatus.Expired },
      connect: vi.fn(),
      disconnect: vi.fn(),
    });

    const { container } = render(<WalletButton />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('has connect button with accessible label', () => {
    useWallet.mockReturnValue({
      state: { status: WalletStatus.Idle },
      connect: vi.fn(),
      disconnect: vi.fn(),
    });

    render(<WalletButton />);
    const btn = screen.getByRole('button', { name: /connect wallet/i });
    expect(btn).toBeInTheDocument();
  });
});
