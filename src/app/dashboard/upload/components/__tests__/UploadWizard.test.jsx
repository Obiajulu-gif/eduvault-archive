import { render, screen } from '@testing-library/react';
import UploadWizard from '../UploadWizard';

vi.mock('next/image', () => ({
  default: ({ alt, ...props }) => <img alt={alt} {...props} />,
}));

vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({
    state: {
      status: 'connected',
      session: { address: 'GB7Y...' },
    },
  }),
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
    <button type="button" onClick={() => onFileSelect?.(new File(['demo'], 'demo.pdf', { type: 'application/pdf' }))}>
      Upload cover image
    </button>
  ),
}));

vi.mock('@/components/PayoutSplits', () => ({
  default: () => <div>Payout Splits</div>,
}));

describe('UploadWizard', () => {
  it('renders the creator upload form with core metadata fields', () => {
    render(<UploadWizard />);

    expect(screen.getByRole('heading', { name: /create a new study resource/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/document title/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/set your price/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/category/i)).toBeInTheDocument();
  });
});
