import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import UploadForm from '../UploadForm';
import UploadWizard from '../UploadWizard';

vi.mock('next/image', () => ({
  default: ({ alt, ...props }) => <img alt={alt} {...props} />,
}));

vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({
    address: 'GB7Y...',
    state: {
      status: 'connected',
      session: { address: 'GB7Y...' },
    },
  }),
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x123', chainId: 1 }),
  useWriteContract: () => ({ writeContract: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ isSuccess: false }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
}));

vi.mock('@/lib/wallet/kit', () => ({
  kit: {
    openModal: vi.fn(),
    setNetwork: vi.fn(),
  },
}));

vi.mock('@/hooks/useDraftAutosave', () => ({
  useDraftAutosave: () => ({ isSaving: false, lastSaved: null }),
}));

vi.mock('@/hooks/api/useMaterials', () => ({
  useUploadFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCreateMaterial: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/providers/TransactionProvider', () => ({
  useTransactionCenter: () => ({
    activeTransaction: { status: 'idle' },
    beginTransaction: vi.fn(),
    markStatus: vi.fn(),
    confirmTransaction: vi.fn(),
    failTransaction: vi.fn(),
    clearTransaction: vi.fn(),
  }),
}));

vi.mock('@/components/transactions/TransactionStatusPanel', () => ({
  default: () => <div data-testid="transaction-status" />,
}));

vi.mock('@/components/DragDropUpload', () => ({
  default: ({ onFileSelect }) => (
    <button type="button" aria-label="Upload cover image" onClick={() => onFileSelect?.(new File(['demo'], 'demo.png', { type: 'image/png' }))}>
      Upload cover image
    </button>
  ),
}));

vi.mock('@/components/PayoutSplits', () => ({
  default: () => <div>Payout Splits</div>,
}));

describe('UploadForm Accessibility and Functionality', () => {
  it('renders the creator upload form with accessible metadata inputs and aria attributes', () => {
    render(<UploadForm />);

    expect(screen.getByRole('heading', { name: /create a new study resource/i })).toBeInTheDocument();
    
    const titleInput = screen.getByLabelText(/document title/i);
    expect(titleInput).toBeInTheDocument();
    expect(titleInput).toHaveAttribute('aria-required', 'true');

    const priceInput = screen.getByLabelText(/set your price/i);
    expect(priceInput).toBeInTheDocument();

    const categorySelect = screen.getByLabelText(/category/i);
    expect(categorySelect).toBeInTheDocument();

    const fileInput = screen.getByLabelText(/upload document file/i);
    expect(fileInput).toBeInTheDocument();
    expect(fileInput).toHaveAttribute('aria-required', 'true');

    expect(screen.getByRole('button', { name: /submit material upload/i })).toBeInTheDocument();
  });

  it('renders accessible visibility radio options inside a fieldset', () => {
    render(<UploadForm />);

    const publicRadio = screen.getByRole('radio', { name: /public/i });
    const privateRadio = screen.getByRole('radio', { name: /private/i });

    expect(publicRadio).toBeInTheDocument();
    expect(privateRadio).toBeInTheDocument();
    expect(publicRadio).toBeChecked();

    fireEvent.click(privateRadio);
    expect(privateRadio).toBeChecked();
  });

  it('displays accessible error alerts with role alert on validation failure', () => {
    render(<UploadForm />);

    const submitBtn = screen.getByRole('button', { name: /submit material upload/i });
    fireEvent.click(submitBtn);

    const titleError = screen.getByText(/title is required/i);
    expect(titleError).toHaveAttribute('role', 'alert');
  });
});

describe('UploadWizard Multi-Step Accessibility', () => {
  it('renders step navigation with accessible step list', () => {
    render(<UploadWizard />);

    expect(screen.getByRole('list', { name: /upload steps/i })).toBeInTheDocument();
    expect(screen.getByText(/upload your document/i)).toBeInTheDocument();
  });
});
