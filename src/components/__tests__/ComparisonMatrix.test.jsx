import { render, screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ComparisonMatrix from '../ComparisonMatrix';
import { useComparison } from '@/hooks/useComparison';

vi.mock('@/hooks/useComparison', () => ({
  useComparison: vi.fn(),
}));

vi.mock('next/image', () => ({
  default: ({ src, alt, fill, ...props }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} {...props} />
  ),
}));

const mockItems = [
  {
    _id: 'mat-1',
    title: 'Intro to Soroban Contracts',
    author: 'Alice Dev',
    price: 15,
    rating: 4.9,
    likes: 42,
    subject: 'Blockchain',
    storageKey: 'intro.pdf',
    usageRights: 'Personal study only.',
    image: '/images/test1.jpg',
  },
  {
    _id: 'mat-2',
    title: 'Advanced Stellar Rust SDK',
    author: 'Bob Engineer',
    price: 25,
    rating: 4.7,
    likes: 18,
    subject: 'Computer Science',
    storageKey: 'stellar.docx',
    usageRights: 'Commercial use permitted.',
    image: '/images/test2.jpg',
  },
];

describe('ComparisonMatrix Accessibility & Keyboard Navigation', () => {
  let mockContext;

  beforeEach(() => {
    mockContext = {
      comparedItems: mockItems,
      isModalOpen: false,
      removeFromComparison: vi.fn(),
      clearComparison: vi.fn(),
      openComparisonModal: vi.fn(),
      closeComparisonModal: vi.fn(),
    };
    useComparison.mockImplementation(() => mockContext);
  });

  describe('Drawer State', () => {
    it('should have no accessibility violations in drawer view', async () => {
      const { container } = render(<ComparisonMatrix />);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it('renders drawer with accessible names for all interactive controls', () => {
      render(<ComparisonMatrix />);

      // Aside / complementary drawer region label
      expect(
        screen.getByRole('complementary', { name: /educational materials comparison drawer/i })
      ).toBeInTheDocument();

      // Drawer toggle button
      const toggleBtn = screen.getByRole('button', { name: /hide comparison items/i });
      expect(toggleBtn).toBeInTheDocument();
      expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');

      // Clear button
      expect(screen.getByRole('button', { name: /clear all compared items/i })).toBeInTheDocument();

      // Compare Now button
      expect(screen.getByRole('button', { name: /compare 2 selected materials side by side/i })).toBeInTheDocument();

      // Remove item buttons
      expect(
        screen.getByRole('button', { name: /remove intro to soroban contracts from comparison/i })
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /remove advanced stellar rust sdk from comparison/i })
      ).toBeInTheDocument();
    });

    it('handles drawer collapse toggle state and accessible attributes', () => {
      render(<ComparisonMatrix />);

      const toggleBtn = screen.getByRole('button', { name: /hide comparison items/i });
      fireEvent.click(toggleBtn);

      expect(screen.getByRole('button', { name: /show comparison items/i })).toHaveAttribute(
        'aria-expanded',
        'false'
      );
    });

    it('triggers clearComparison and removeFromComparison via accessible buttons', () => {
      render(<ComparisonMatrix />);

      fireEvent.click(screen.getByRole('button', { name: /clear all compared items/i }));
      expect(mockContext.clearComparison).toHaveBeenCalled();

      fireEvent.click(
        screen.getByRole('button', { name: /remove intro to soroban contracts from comparison/i })
      );
      expect(mockContext.removeFromComparison).toHaveBeenCalledWith('mat-1');
    });
  });

  describe('Modal State', () => {
    beforeEach(() => {
      mockContext.isModalOpen = true;
    });

    it('should have no accessibility violations in modal view', async () => {
      const { container } = render(<ComparisonMatrix />);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it('renders comparison dialog with role="dialog", aria-modal="true", and accessible title', () => {
      render(<ComparisonMatrix />);

      const dialog = screen.getByRole('dialog', {
        name: /educational resource comparison matrix/i,
      });
      expect(dialog).toBeInTheDocument();
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-labelledby', 'comparison-modal-title');
      expect(dialog).toHaveAttribute('aria-describedby', 'comparison-modal-desc');
    });

    it('closes modal on Escape key press via focus trap handler', () => {
      render(<ComparisonMatrix />);

      fireEvent.keyDown(document, {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
      });

      expect(mockContext.closeComparisonModal).toHaveBeenCalled();
    });

    it('renders accessible close and remove buttons inside modal table', () => {
      render(<ComparisonMatrix />);

      // Header close button & footer close button
      const closeButtons = screen.getAllByRole('button', { name: /close comparison modal/i });
      expect(closeButtons.length).toBeGreaterThanOrEqual(2);

      // Remove buttons inside table headers
      const removeButtons = screen.getAllByRole('button', {
        name: /remove intro to soroban contracts from comparison/i,
      });
      expect(removeButtons.length).toBeGreaterThanOrEqual(1);

      fireEvent.click(closeButtons[0]);
      expect(mockContext.closeComparisonModal).toHaveBeenCalled();
    });
  });

  describe('Empty State', () => {
    it('renders nothing when comparedItems is empty', () => {
      mockContext.comparedItems = [];
      const { container } = render(<ComparisonMatrix />);
      expect(container).toBeEmptyDOMElement();
    });
  });
});
