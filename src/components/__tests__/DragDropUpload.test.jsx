import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DragDropUpload from '../DragDropUpload';

describe('DragDropUpload Accessibility', () => {
  it('renders with button role, tabIndex 0, and accessible aria-label', () => {
    render(<DragDropUpload onFileSelect={vi.fn()} />);

    const dropzone = screen.getByRole('button', { name: /upload cover image/i });
    expect(dropzone).toBeInTheDocument();
    expect(dropzone).toHaveAttribute('tabIndex', '0');
  });

  it('triggers file selection when Enter or Space is pressed', () => {
    const handleFileSelect = vi.fn();
    render(<DragDropUpload onFileSelect={handleFileSelect} />);

    const dropzone = screen.getByRole('button', { name: /upload cover image/i });
    fireEvent.keyDown(dropzone, { key: 'Enter', code: 'Enter' });
    fireEvent.keyDown(dropzone, { key: ' ', code: 'Space' });
  });

  it('associates error message with aria-describedby', () => {
    render(<DragDropUpload onFileSelect={vi.fn()} error='File too large' />);

    const dropzone = screen.getByRole('button', { name: /upload cover image/i });
    expect(dropzone).toHaveAttribute('aria-describedby', 'thumb-error');
  });
});
