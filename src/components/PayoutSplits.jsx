"use client";

import { useState, useEffect } from "react";
import { FaPlus, FaTrash } from "react-icons/fa";

export default function PayoutSplits({ onChange, initialSplits = [] }) {
  const [splits, setSplits] = useState(
    initialSplits.length > 0
      ? initialSplits
      : [{ address: "", percentage: 100 }],
  );
  const [errors, setErrors] = useState(() => {
    const newErrors = {};
    const initial = initialSplits.length > 0 ? initialSplits : [{ address: "", percentage: 100 }];
    let totalPercentage = 0;
    initial.forEach((split, index) => {
      if (split.address && !/^G[A-Z0-9]{55}$/.test(split.address)) {
        newErrors[`address_${index}`] = "Invalid Stellar wallet address";
      }
      const pct = parseFloat(split.percentage) || 0;
      if (pct <= 0) newErrors[`percentage_${index}`] = "Percentage must be greater than 0";
      if (pct > 100) newErrors[`percentage_${index}`] = "Percentage cannot exceed 100";
      totalPercentage += pct;
    });
    if (Math.abs(totalPercentage - 100) > 0.01) {
      newErrors.total = `Total must equal 100% (currently ${totalPercentage.toFixed(2)}%)`;
    }
    return newErrors;
  });

  const validateWalletAddress = (address) => {
    // Stellar public key validation (starts with G, 56 characters)
    const stellarRegex = /^G[A-Z0-9]{55}$/;
    return stellarRegex.test(address);
  };

  const validateSplits = () => {
    const newErrors = {};
    let totalPercentage = 0;

    splits.forEach((split, index) => {
      // Validate wallet address
      if (split.address && !validateWalletAddress(split.address)) {
        newErrors[`address_${index}`] = "Invalid Stellar wallet address";
      }

      // Check for duplicate addresses
      const duplicateIndex = splits.findIndex(
        (s, i) => i !== index && s.address && s.address === split.address,
      );
      if (duplicateIndex !== -1 && split.address) {
        newErrors[`address_${index}`] = "Duplicate wallet address";
      }

      // Validate percentage
      const percentage = parseFloat(split.percentage) || 0;
      if (percentage <= 0) {
        newErrors[`percentage_${index}`] = "Percentage must be greater than 0";
      }
      if (percentage > 100) {
        newErrors[`percentage_${index}`] = "Percentage cannot exceed 100";
      }

      totalPercentage += percentage;
    });

    // Validate total equals 100%
    if (Math.abs(totalPercentage - 100) > 0.01) {
      newErrors.total = `Total must equal 100% (currently ${totalPercentage.toFixed(2)}%)`;
    }

    setErrors(newErrors);

    // Notify parent component
    const isValid = Object.keys(newErrors).length === 0;
    onChange(isValid ? splits : null, isValid);

    return isValid;
  };


  const handleAddSplit = () => {
    const currentTotal = splits.reduce(
      (sum, s) => sum + (parseFloat(s.percentage) || 0),
      0,
    );
    const remaining = Math.max(0, 100 - currentTotal);

    setSplits([...splits, { address: "", percentage: remaining }]);
  };

  const handleRemoveSplit = (index) => {
    if (splits.length === 1) return;

    const newSplits = splits.filter((_, i) => i !== index);
    const total = newSplits.reduce(
      (sum, s) => sum + (parseFloat(s.percentage) || 0),
      0,
    );

    // Redistribute percentages if needed
    if (total === 0) {
      newSplits[0].percentage = 100;
    }

    setSplits(newSplits);
  };

  const handleAddressChange = (index, value) => {
    const newSplits = [...splits];
    newSplits[index].address = value.trim();
    setSplits(newSplits);
  };

  const handlePercentageChange = (index, value) => {
    const newSplits = [...splits];
    const numValue = parseFloat(value) || 0;
    newSplits[index].percentage = Math.max(0, Math.min(100, numValue));
    setSplits(newSplits);
  };

  const distributeEvenly = () => {
    const evenPercentage = (100 / splits.length).toFixed(2);
    const newSplits = splits.map((split, index) => ({
      ...split,
      percentage:
        index === 0
          ? (100 - evenPercentage * (splits.length - 1)).toFixed(2)
          : evenPercentage,
    }));
    setSplits(newSplits);
  };

  const totalPercentage = splits.reduce(
    (sum, s) => sum + (parseFloat(s.percentage) || 0),
    0,
  );

  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold">Payout Split Configuration</h3>
          <p className="text-xs text-gray-600 mt-1">
            Configure revenue sharing with co-authors. Total must equal 100%.
          </p>
        </div>
        {splits.length > 1 && (
          <button
            type="button"
            onClick={distributeEvenly}
            className="text-xs text-blue-600 hover:text-blue-700 font-medium"
          >
            Distribute Evenly
          </button>
        )}
      </div>

      <div className="space-y-3">
        {splits.map((split, index) => (
          <div key={index} className="flex gap-2 items-start">
            <div className="flex-1">
              <input
                type="text"
                value={split.address}
                onChange={(e) => handleAddressChange(index, e.target.value)}
                placeholder="Stellar wallet address (G...)"
                className={`w-full border rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500 ${
                  errors[`address_${index}`]
                    ? "border-red-500"
                    : "border-gray-300"
                }`}
              />
              {errors[`address_${index}`] && (
                <p className="text-red-600 text-xs mt-1">
                  {errors[`address_${index}`]}
                </p>
              )}
            </div>
            <div className="w-24">
              <input
                type="number"
                value={split.percentage}
                onChange={(e) => handlePercentageChange(index, e.target.value)}
                min="0"
                max="100"
                step="0.01"
                className={`w-full border rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500 ${
                  errors[`percentage_${index}`]
                    ? "border-red-500"
                    : "border-gray-300"
                }`}
              />
              {errors[`percentage_${index}`] && (
                <p className="text-red-600 text-xs mt-1">
                  {errors[`percentage_${index}`]}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => handleRemoveSplit(index)}
              disabled={splits.length === 1}
              className="p-2 text-red-600 hover:bg-red-50 rounded-md disabled:opacity-30 disabled:cursor-not-allowed mt-1"
              aria-label="Remove split"
            >
              <FaTrash className="text-sm" />
            </button>
          </div>
        ))}
      </div>

      <div className="mt-3 pt-3 border-t border-gray-200">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Total:</span>
            <span
              className={`text-sm font-bold ${
                Math.abs(totalPercentage - 100) < 0.01
                  ? "text-green-600"
                  : "text-red-600"
              }`}
            >
              {totalPercentage.toFixed(2)}%
            </span>
          </div>
          <button
            type="button"
            onClick={handleAddSplit}
            className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700 font-medium"
          >
            <FaPlus className="text-xs" />
            Add Co-Author
          </button>
        </div>
        {errors.total && (
          <p className="text-red-600 text-xs mt-2">{errors.total}</p>
        )}
      </div>
    </div>
  );
}
