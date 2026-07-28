"use client";

import { useState } from "react";
import StudentVerificationForm from "@/components/StudentVerificationForm";
import { useWallet } from "@/hooks/useWallet";
import { WalletStatus } from "@/providers/WalletProvider";

export default function StudentVerificationPage() {
  const { state } = useWallet();
  const [verificationStatus, setVerificationStatus] = useState(null);

  const isConnected = state.status === WalletStatus.Connected;

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-3xl mx-auto">
        <div className="bg-white shadow rounded-lg">
          <div className="px-6 py-8 sm:p-10">
            <div className="mb-8">
              <h1 className="text-3xl font-bold text-gray-900 mb-2">
                Student Verification
              </h1>
              <p className="text-gray-600">
                Verify your student status to unlock exclusive pricing and
                benefits
              </p>
            </div>

            {!isConnected ? (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 text-center">
                <svg
                  className="mx-auto h-12 w-12 text-yellow-400 mb-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
                <h3 className="text-lg font-medium text-yellow-900 mb-2">
                  Wallet Connection Required
                </h3>
                <p className="text-sm text-yellow-700 mb-4">
                  Please connect your wallet to submit a verification
                  application
                </p>
                <button
                  onClick={() => {
                    // Trigger wallet connection - this would be handled by your wallet provider
                    console.log("Connect wallet triggered");
                  }}
                  className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-yellow-700 bg-yellow-100 hover:bg-yellow-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-yellow-500"
                >
                  Connect Wallet
                </button>
              </div>
            ) : verificationStatus === "submitted" ? (
              <div className="bg-green-50 border border-green-200 rounded-lg p-6 text-center">
                <svg
                  className="mx-auto h-12 w-12 text-green-400 mb-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <h3 className="text-lg font-medium text-green-900 mb-2">
                  Application Submitted Successfully
                </h3>
                <p className="text-sm text-green-700 mb-4">
                  Your student verification application is under review. We will
                  notify you once the verification is complete (typically within
                  1-3 business days).
                </p>
                <div className="text-xs text-green-600">
                  <p>What happens next:</p>
                  <ul className="mt-2 space-y-1 text-left max-w-md mx-auto">
                    <li>• Our team reviews your submitted documents</li>
                    <li>
                      • You&apos;ll receive an email notification with the decision
                    </li>
                    <li>
                      • Once approved, student pricing will automatically apply
                    </li>
                  </ul>
                </div>
              </div>
            ) : (
              <>
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
                  <h3 className="text-sm font-semibold text-blue-900 mb-2">
                    Benefits of Student Verification
                  </h3>
                  <ul className="text-sm text-blue-800 space-y-1">
                    <li>
                      • Access to exclusive student pricing (up to 50% off)
                    </li>
                    <li>• Priority access to educational materials</li>
                    <li>• Eligible for student-only promotions</li>
                    <li>• Free access to select community resources</li>
                  </ul>
                </div>

                <StudentVerificationForm
                  onSuccess={() => setVerificationStatus("submitted")}
                  userAddress={state.session?.address}
                />
              </>
            )}
          </div>
        </div>

        <div className="mt-6 bg-white shadow rounded-lg px-6 py-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">
            Acceptable Documents
          </h3>
          <div className="grid sm:grid-cols-2 gap-4 text-sm text-gray-600">
            <div>
              <h4 className="font-medium text-gray-900 mb-1">
                Valid Documents:
              </h4>
              <ul className="space-y-1">
                <li>• Current student ID card</li>
                <li>• Enrollment verification letter</li>
                <li>• Current semester schedule</li>
                <li>• Transcript (with current dates)</li>
              </ul>
            </div>
            <div>
              <h4 className="font-medium text-gray-900 mb-1">Requirements:</h4>
              <ul className="space-y-1">
                <li>• Documents must be current</li>
                <li>• Clear and legible scans</li>
                <li>• Maximum file size: 5MB</li>
                <li>• Formats: JPG, PNG, or PDF</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
