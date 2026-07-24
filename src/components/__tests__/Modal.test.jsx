import { render, screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import Modal from '../Modal';
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Modal Accessibility Baseline', () => {
  let onClose;

  beforeEach(() => {
    onClose = vi.fn();
  });

  it('should have no accessibility violations', async () => {
    const { container } = render(
      <Modal isOpen={true} onClose={onClose} title="Test Modal">
        <p>Modal Content</p>
      </Modal>
    );

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('should have no accessibility violations when title is omitted but ariaLabel is provided', async () => {
    const { container } = render(
      <Modal isOpen={true} onClose={onClose} ariaLabel="Accessible Modal Without Title">
        <p>Modal Content</p>
      </Modal>
    );

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('should close on Escape key', () => {
    render(
      <Modal isOpen={true} onClose={onClose} title="Test Modal">
        <button>Click Me</button>
      </Modal>
    );

    fireEvent.keyDown(document, {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27
    });

    expect(onClose).toHaveBeenCalled();
  });

  it('should close when clicking backdrop', () => {
    render(
      <Modal isOpen={true} onClose={onClose} title="Test Modal">
        <p>Modal Content</p>
      </Modal>
    );

    const backdrop = screen.getByRole('presentation');
    fireEvent.click(backdrop);

    expect(onClose).toHaveBeenCalled();
  });

  it('has accessible dialog role with correct attributes', () => {
    render(
      <Modal isOpen={true} onClose={onClose} title="Test Modal">
        <p>Modal Content</p>
      </Modal>
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby');
  });

  it('should return focus to trigger element on close', () => {
    const triggerButton = document.createElement('button');
    triggerButton.textContent = 'Open Modal';
    document.body.appendChild(triggerButton);
    triggerButton.focus();

    const { rerender } = render(
      <Modal isOpen={true} onClose={onClose} title="Test Modal">
        <p>Modal Content</p>
      </Modal>
    );

    rerender(
      <Modal isOpen={false} onClose={onClose} title="Test Modal">
        <p>Modal Content</p>
      </Modal>
    );

    expect(document.activeElement).toBe(triggerButton);
    document.body.removeChild(triggerButton);
  });
});
