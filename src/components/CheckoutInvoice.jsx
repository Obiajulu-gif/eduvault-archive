"use client";

import { useState, useEffect } from "react";
import { FaSpinner, FaCheckCircle } from "react-icons/fa";

export default function CheckoutInvoice({ material, onConfirm, onCancel }) {
  const [networkFee, setNetworkFee] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [usdPrice, setUsdPrice] = useState(null);

  useEffect(() => {
    const fetchFeeAndPrice = async () => {
      try {
        setLoading(true);
        const [feeRes, priceRes] = await Promise.all([
          fetch("/api/stellar/network-fee"),
          fetch("/api/stellar/xlm-price"),
        ]);

        if (!feeRes.ok || !priceRes.ok) {
          throw new Error("Failed to fetch pricing information");
        }

        const feeData = await feeRes.json();
        const priceData = await priceRes.json();

        setNetworkFee(feeData.fee);
        const usd = material.price * (priceData.usdPrice || 0);
        setUsdPrice(usd);
      } catch (err) {
        setError(err.message);
        setNetworkFee(0.0001);
      } finally {
        setLoading(false);
      }
    };

    fetchFeeAndPrice();
  }, [material]);

  const total = material.price + (networkFee || 0);
  const totalUsd = usdPrice ? (total * 10).toFixed(2) : null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6 space-y-6">
        <h2 className="text-xl font-semibold text-gray-900">Checkout Summary</h2>

        {loading && (
          <div className="flex items-center justify-center py-8">
            <FaSpinner className="animate-spin text-blue-600 text-2xl" />
          </div>
        )}

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {!loading && !error && (
          <>
            <div className="space-y-4 border-b border-gray-200 pb-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-900">{material.title}</p>
                  <p className="text-xs text-gray-500 mt-1">Creator: {material.creator}</p>
                </div>
                <p className="text-sm font-medium text-gray-900">
                  {material.price} XLM
                </p>
              </div>

              <div className="flex justify-between items-center pt-2">
                <p className="text-sm text-gray-600">Network Fee</p>
                <p className="text-sm text-gray-900 font-medium">
                  {networkFee?.toFixed(6)} XLM
                </p>
              </div>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <div className="flex justify-between items-center mb-2">
                <p className="text-lg font-semibold text-gray-900">Total</p>
                <p className="text-lg font-semibold text-blue-600">
                  {total.toFixed(6)} XLM
                </p>
              </div>
              {totalUsd && (
                <p className="text-sm text-gray-600 text-right">
                  Approx. ${totalUsd} USD
                </p>
              )}
            </div>

            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
              <p className="text-xs text-yellow-800">
                <span className="font-medium">Note:</span> You will be asked to confirm this purchase with your Stellar wallet. Please review all details before signing the transaction.
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={onCancel}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={onConfirm}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
              >
                <FaCheckCircle size={14} />
                Confirm & Sign
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
