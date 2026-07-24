import { render } from '@testing-library/react';
import { axe } from 'jest-axe';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({
    state: { status: 'idle' },
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: false,
    address: null,
    balances: null,
  }),
  WalletStatus: { Idle: 'idle', Connected: 'connected' },
}));

vi.mock('@/hooks/useCart', () => ({
  useCart: () => ({
    cartItems: [],
    isCartOpen: false,
    setIsCartOpen: vi.fn(),
    removeFromCart: vi.fn(),
    totals: { subtotal: 0, estimatedFees: 0, creatorSplit: 0, platformSplit: 0 },
    checkout: vi.fn(),
  }),
}));

vi.mock('@/hooks/useNotifications', () => ({
  useNotifications: () => ({
    notifications: [],
    unreadCount: 0,
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    clearAll: vi.fn(),
  }),
}));

vi.mock('@/hooks/useThemePreference', () => ({
  useThemePreference: () => ({
    isDark: false,
    toggleTheme: vi.fn(),
  }),
}));

describe('Critical Component Accessibility (axe checks)', () => {
  it('FormField has no violations', async () => {
    const FormField = (await import('@/components/FormField')).default;
    const { container } = render(
      <FormField label="Email" type="email" placeholder="Enter email" />
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('FormField with error has no violations', async () => {
    const FormField = (await import('@/components/FormField')).default;
    const { container } = render(
      <FormField label="Email" type="email" error="Invalid email" value="bad" onChange={vi.fn()} />
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('ThemeToggle has no violations', async () => {
    const ThemeToggle = (await import('@/components/ThemeToggle')).default;
    const { container } = render(<ThemeToggle />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
