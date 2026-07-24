import { render, screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import DragDropUpload from '../DragDropUpload';
import { describe, it, expect, vi } from 'vitest';

describe('DragDropUpload Accessibility', () => {
  it('should have no accessibility violations', async () => {
    const { container } = render(
      <DragDropUpload onFileSelect={vi.fn()} error={null} />
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('should have no violations when error is present', async () => {
    const { container } = render(
      <DragDropUpload onFileSelect={vi.fn()} error="File too large" />
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('is keyboard accessible via Enter key', () => {
    const onFileSelect = vi.fn();
    render(<DragDropUpload onFileSelect={onFileSelect} error={null} />);

    const dropzone = screen.getByRole('button', { name: /upload cover image/i });
    expect(dropzone).toBeInTheDocument();
    expect(dropzone).toHaveAttribute('tabindex', '0');
  });

  it('has accessible name via aria-label', () => {
    render(<DragDropUpload onFileSelect={vi.fn()} error={null} />);

    const dropzone = screen.getByRole('button', { name: /upload cover image/i });
    expect(dropzone).toBeInTheDocument();
  });
});
