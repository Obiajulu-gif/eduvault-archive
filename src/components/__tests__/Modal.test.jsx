import { render, screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import Modal from '../Modal';
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Modal Accessibility Baseline', () => {
  // Use a mock function to track if the modal tries to close
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
    
    // Runs the automated WCAG audit
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('should have no accessibility violations when title is omitted but ariaLabel is provided', async () => {
    const { container } = render(
      <Modal isOpen={true} onClose={onClose} ariaLabel="Accessible Modal Without Title">
        <p>Modal Content</p>
      </Modal>
    );
    
    // Runs the automated WCAG audit on the ariaLabel state
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('should close on Escape key', async () => {
    render(
      <Modal isOpen={true} onClose={onClose} title="Test Modal">
        <button aria-label="Inner Button">Click Me</button>
      </Modal>
    );

    // Target 'document' specifically to match the listener in useFocusTrap.js
    fireEvent.keyDown(document, { 
      key: 'Escape', 
      code: 'Escape',
      keyCode: 27 
    });
    
    expect(onClose).toHaveBeenCalled();
  });
});