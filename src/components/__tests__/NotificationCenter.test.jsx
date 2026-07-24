import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import NotificationCenter from '../notifications/NotificationCenter';
import { describe, it, expect, vi } from 'vitest';

const useNotificationsMock = vi.hoisted(() =>
  vi.fn(() => ({
    notifications: [],
    unreadCount: 0,
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    clearAll: vi.fn(),
  }))
);

vi.mock('@/hooks/useNotifications', () => ({
  useNotifications: useNotificationsMock,
}));

describe('NotificationCenter Accessibility', () => {
  it('should have no accessibility violations when closed', async () => {
    const { container } = render(<NotificationCenter />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('has accessible button with unread count', () => {
    render(<NotificationCenter />);
    const btn = screen.getByRole('button', { name: /notifications/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows unread count in aria-label', () => {
    useNotificationsMock.mockReturnValueOnce({
      notifications: [{ id: '1', title: 'Test', message: 'Hello', read: false, createdAt: new Date() }],
      unreadCount: 1,
      markRead: vi.fn(),
      markAllRead: vi.fn(),
      clearAll: vi.fn(),
    });

    render(<NotificationCenter />);
    const btn = screen.getByRole('button', { name: /1 unread/i });
    expect(btn).toBeInTheDocument();
  });
});
