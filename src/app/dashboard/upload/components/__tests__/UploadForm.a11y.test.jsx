/**
 * src/app/dashboard/upload/components/__tests__/UploadForm.a11y.test.jsx
 *
 * #795: automated accessibility checks for the primary creator workflow
 * (the upload/publish form). Runs the jest-axe WCAG audit against the
 * rendered form and asserts the keyboard/screen-reader contract:
 *
 *   ✓ No axe violations on initial render
 *   ✓ Every form field has an accessible label
 *   ✓ Required fields are announced (aria-required)
 *   ✓ Field errors are described (aria-describedby) and announced (role=alert)
 *   ✓ The submit button exposes an accessible name and busy state
 */

import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mocks for the form's hooks and providers ─────────────────────────────────

const { walletState } = vi.hoisted(() => ({
  walletState: { value: { status: 'idle', session: null } },
}));

vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ state: walletState.value }),
}));

vi.mock('@/hooks/api/useMaterials', () => ({
  useUploadFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCreateMaterial: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/providers/TransactionProvider', () => ({
  useTransactionCenter: () => ({
    activeTransaction: null,
    beginTransaction: vi.fn(),
    markStatus: vi.fn(),
    confirmTransaction: vi.fn(),
    failTransaction: vi.fn(),
    clearTransaction: vi.fn(),
  }),
}));

import UploadForm from '../UploadForm';

describe('UploadForm accessibility (#795)', () => {
  beforeEach(() => {
    walletState.value = { status: 'idle', session: null };
  });

  it('has no axe violations on initial render', async () => {
    const { container } = render(<UploadForm />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('gives every input an accessible label', () => {
    render(<UploadForm />);

    for (const id of [
      'material-title',
      'material-description',
      'file-upload',
      'material-category',
      'material-price',
      'material-usage-rights',
      'material-level',
    ]) {
      const field = document.getElementById(id);
      expect(field, `#${id} should exist`).toBeTruthy();
      // An accessible name comes from a linked <label>, aria-label, or
      // aria-labelledby — axe's label rule covers this, but we assert the
      // wiring explicitly so a refactor can't silently drop it.
      const labelledBy = field.getAttribute('aria-labelledby');
      const ariaLabel = field.getAttribute('aria-label');
      const hasLinkedLabel = !!document.querySelector(`label[for="${id}"]`);
      expect(
        hasLinkedLabel || ariaLabel || labelledBy,
        `#${id} must have an accessible label`,
      ).toBeTruthy();
    }
  });

  it('marks required fields so screen readers announce them', () => {
    render(<UploadForm />);

    const title = document.getElementById('material-title');
    expect(title).toHaveAttribute('aria-required', 'true');

    const file = document.getElementById('file-upload');
    expect(file).toHaveAttribute('aria-required', 'true');
  });

  it('describes field errors with aria-describedby and announces them with role=alert', () => {
    render(<UploadForm />);

    // Trigger validation by submitting the empty form.
    const submit = screen.getByRole('button', { name: /submit upload/i });
    submit.click();

    // The title error should be linked from the input and announced.
    const title = document.getElementById('material-title');
    const errorId = title.getAttribute('aria-describedby');
    expect(errorId).toBeTruthy();
    const error = document.getElementById(errorId);
    expect(error).toHaveAttribute('role', 'alert');
    expect(error.textContent).toMatch(/title is required/i);
  });

  it('exposes an accessible name and busy state on the submit button', () => {
    render(<UploadForm />);
    const submit = screen.getByRole('button', { name: /submit upload/i });
    expect(submit).toHaveAttribute('aria-busy', 'false');
  });
});
