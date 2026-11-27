/**
 * #1153: keyboard and async-status accessibility for the global session
 * timeout dialog (SessionWarning, mounted in src/app/layout.js).
 *
 * Runs the real useSessionExpiry hook with fetch mocked at the network edge:
 *   normal         warning opens with focus inside; Enter renews; focus returns
 *   async status   busy state while renewing, role=alert on failure, countdown
 *                  is a timer rather than a per-second live announcement
 *   retry          a failed renewal can be retried and the alert clears
 *   authorization  a rejected refresh (401) switches to the expired dialog
 */
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { axe, toHaveNoViolations } from 'jest-axe';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import SessionWarning from '../SessionWarning';

expect.extend(toHaveNoViolations);

const json = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// Inside the hook's 2-minute warning window, so the warning shows immediately.
const expiringSoon = () => json(200, { authenticated: true, expiresAt: Date.now() + 60_000 });
const renewed = () => json(200, { authenticated: true, expiresAt: Date.now() + 60 * 60_000 });

let sessionResponses;
let refreshResponse;

beforeEach(() => {
  sessionResponses = [expiringSoon];
  refreshResponse = () => json(200, { success: true });
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url === '/api/auth/refresh') return refreshResponse();
    const next = sessionResponses.length > 1 ? sessionResponses.shift() : sessionResponses[0];
    return next();
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderWithPage() {
  const user = userEvent.setup();
  const view = render(
    <>
      <button type="button">Page action</button>
      <SessionWarning />
    </>,
  );
  screen.getByRole('button', { name: 'Page action' }).focus();
  return { user, ...view };
}

const warningDialog = () => screen.findByRole('alertdialog', { name: 'Your session is about to expire' });
const keepButton = () => screen.getByRole('button', { name: /keep me signed in|renewing/i });

describe('SessionWarning accessibility (#1153)', () => {
  it('renders nothing while the session is not near expiry', async () => {
    sessionResponses = [renewed];
    render(<SessionWarning />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('normal: moves focus into the warning dialog and keeps Tab inside it', async () => {
    const { user } = renderWithPage();
    const dialog = await warningDialog();

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription(/signed out soon/i);
    await waitFor(() => expect(keepButton()).toHaveFocus());

    await user.tab();
    expect(keepButton()).toHaveFocus();
    await user.tab({ shift: true });
    expect(keepButton()).toHaveFocus();
  });

  it('async status: the countdown is a timer, not a polite live region', async () => {
    renderWithPage();
    await warningDialog();
    const timer = screen.getByRole('timer');
    expect(timer).not.toHaveAttribute('aria-live', 'polite');
    expect(timer.textContent).toMatch(/^\d+:\d{2}$/);
  });

  it('normal: Enter renews the session, closes the dialog and returns focus to the page', async () => {
    const { user } = renderWithPage();
    await warningDialog();
    await waitFor(() => expect(keepButton()).toHaveFocus());
    sessionResponses = [renewed];

    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(fetch).toHaveBeenCalledWith('/api/auth/refresh', expect.objectContaining({ method: 'POST' }));
    expect(screen.getByRole('button', { name: 'Page action' })).toHaveFocus();
  });

  it('async status + retry: busy while renewing, alert on failure, retry clears it', async () => {
    const { user } = renderWithPage();
    await warningDialog();
    await waitFor(() => expect(keepButton()).toHaveFocus());

    let failRefresh;
    refreshResponse = () => new Promise((_, reject) => { failRefresh = reject; });
    await user.keyboard('{Enter}');

    const busy = await screen.findByRole('button', { name: 'Renewing...' });
    expect(busy).toBeDisabled();

    failRefresh(new TypeError('Failed to fetch'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to renew your session. Please sign in again.');
    expect(keepButton()).toBeEnabled();
    expect(keepButton()).toHaveTextContent('Keep me signed in');

    refreshResponse = () => json(200, { success: true });
    sessionResponses = [renewed];
    await user.click(keepButton());

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('authorization: a rejected refresh shows the expired dialog with focus on its only action', async () => {
    const { user } = renderWithPage();
    await warningDialog();
    await waitFor(() => expect(keepButton()).toHaveFocus());
    refreshResponse = () => json(401, { error: 'Unauthorized' });

    await user.keyboard('{Enter}');

    expect(await screen.findByRole('alertdialog', { name: 'Session expired' })).toHaveAttribute('aria-modal', 'true');
    const signIn = screen.getByRole('button', { name: 'Sign in again' });
    await waitFor(() => expect(signIn).toHaveFocus());
    expect(screen.queryByRole('alertdialog', { name: 'Your session is about to expire' })).toBeNull();

    // Escape must not dismiss a dialog that has no dismiss action.
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    expect(screen.getByRole('alertdialog', { name: 'Session expired' })).toBeInTheDocument();
  });

  it('has no axe violations in the warning or expired dialog', async () => {
    const { container, user } = renderWithPage();
    await warningDialog();
    expect(await axe(container)).toHaveNoViolations();

    refreshResponse = () => json(401);
    await user.click(keepButton());
    await screen.findByRole('alertdialog', { name: 'Session expired' });
    expect(await axe(container)).toHaveNoViolations();
  });
});
