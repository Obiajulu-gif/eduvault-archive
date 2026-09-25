'use client';

import { useTransactionCenter } from '@/providers/TransactionProvider';
import { TransactionStatus } from '@/lib/transactions/transaction';
import Modal from '@/components/Modal';
import { FaCheckCircle, FaExclamationCircle, FaSpinner } from 'react-icons/fa';

const phases = [
  { id: 1, label: 'Building Transaction' },
  { id: 2, label: 'Requesting Signature' },
  { id: 3, label: 'Submitting to Network' },
  { id: 4, label: 'Confirmation' },
];

export default function TransactionModal() {
  const { activeTransaction, clearTransaction, retryTransaction } = useTransactionCenter();
  const { status, title, message, error, explorerUrl } = activeTransaction;

  const isOpen = status !== TransactionStatus.Idle;

  // Determine current active phase based on status
  let currentPhaseIndex = 0; // Phase 1 (Building)
  let isError = false;
  let isSuccess = false;

  switch (status) {
    case TransactionStatus.WaitingWallet:
      currentPhaseIndex = 0; // Phase 1
      break;
    case TransactionStatus.Signing:
      currentPhaseIndex = 1; // Phase 2
      break;
    case TransactionStatus.Submitting:
    case TransactionStatus.PendingConfirmation:
      currentPhaseIndex = 2; // Phase 3
      break;
    case TransactionStatus.Confirmed:
      currentPhaseIndex = 3; // Phase 4
      isSuccess = true;
      break;
    case TransactionStatus.Failed:
    case TransactionStatus.NeedsRetry:
      currentPhaseIndex = 3; // Phase 4
      isError = true;
      break;
    default:
      currentPhaseIndex = 0;
      break;
  }

  return (
    <Modal isOpen={isOpen} onClose={clearTransaction} title={title || "Transaction Phase"}>
      <div className="flex flex-col gap-6 mt-4">
        {/* Phase Stepper */}
        <div className="flex flex-col gap-4">
          {phases.map((phase, index) => {
            const isCompleted = index < currentPhaseIndex || (index === 3 && isSuccess);
            const isCurrent = index === currentPhaseIndex && !isSuccess && !isError;
            const isFailedPhase = index === currentPhaseIndex && isError;
            
            return (
              <div key={phase.id} className="flex items-center gap-4">
                <div className="relative flex items-center justify-center w-8 h-8 rounded-full shrink-0">
                  {isCompleted ? (
                    <FaCheckCircle className="w-8 h-8 text-emerald-500" />
                  ) : isFailedPhase ? (
                    <FaExclamationCircle className="w-8 h-8 text-rose-500" />
                  ) : isCurrent ? (
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-blue-100 text-blue-600">
                      <FaSpinner className="w-4 h-4 animate-spin" />
                    </div>
                  ) : (
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-slate-100 text-slate-400 font-bold text-sm">
                      {phase.id}
                    </div>
                  )}
                  {/* Vertical connecting line */}
                  {index < phases.length - 1 && (
                    <div className={`absolute top-8 left-1/2 w-0.5 h-6 -translate-x-1/2 ${index < currentPhaseIndex ? 'bg-emerald-500' : 'bg-slate-200'}`} />
                  )}
                </div>
                
                <div className="flex flex-col">
                  <span className={`text-sm font-semibold ${isCompleted ? 'text-slate-800' : isFailedPhase ? 'text-rose-600' : isCurrent ? 'text-blue-600' : 'text-slate-400'}`}>
                    {phase.label}
                  </span>
                  {isCurrent && !isFailedPhase && index === 1 && (
                    <span className="text-xs text-slate-500">Please approve in your wallet</span>
                  )}
                  {isCurrent && !isFailedPhase && index === 2 && (
                    <span className="text-xs text-slate-500">Waiting for ledger confirmation...</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Message / Error Details */}
        {(message || error) && (
          <div className={`p-4 rounded-lg text-sm ${isError ? 'bg-rose-50 text-rose-800 border border-rose-200' : 'bg-blue-50 text-blue-800 border border-blue-200'}`}>
            {message && <p className="font-medium">{message}</p>}
            {error && <p className="text-xs mt-1 opacity-80">{error.message || String(error)}</p>}
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-col gap-2 mt-2">
          {isSuccess && explorerUrl && (
            <a 
              href={explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full text-center py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-lg transition-colors text-sm"
            >
              View on Explorer
            </a>
          )}
          
          {(isSuccess || isError) && (
            <button
              onClick={clearTransaction}
              className={`w-full py-2.5 font-bold rounded-lg transition-colors text-white ${isSuccess ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-slate-800 hover:bg-slate-900'}`}
            >
              Close
            </button>
          )}

          {isError && activeTransaction.retryable && (
            <button
              onClick={() => retryTransaction()}
              className="w-full py-2.5 font-bold rounded-lg transition-colors bg-rose-600 hover:bg-rose-700 text-white"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
