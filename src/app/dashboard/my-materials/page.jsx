"use client";

import { useAccount } from "wagmi";

export default function MyMaterialsPage() {
  const { address } = useAccount();

  if (!address) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-600 text-sm">
          Connect your wallet to view your uploaded materials.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <div className="max-w-6xl mx-auto py-10 px-6">
        <h1 className="text-2xl font-bold mb-6">My Materials</h1>
        <p className="text-sm text-gray-600 max-w-2xl">
          This page will list Soroban-backed materials once the new chain layer is live. The legacy Celo token inventory has been retired from the active UI.
        </p>
      </div>
    </div>
  );
}
