'use client';

import React, { useState, useEffect } from 'react';
import { validateCheckoutBalance } from '@/lib/stellar/checkoutService';
import PromoInput from '@/components/PromoInput';

/**
 * CheckoutInvoice — displays a breakdown of cart totals with optional promo discount,
 * and validates the user's Stellar balance before allowing checkout.
 */
export default function CheckoutInvoice({
  walletAddress,
  subtotal,
  estimatedFees,
  promoCode,
  onPromoApply,
  onPromoRemove,
  onConfirm,
  disabled = false,
}) {
  const [balanceStatus, setBalanceStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  // Calculate pricing based on promos
  const discountPercent = promoCode?.discountPercent || 0;
  const discountAmount = subtotal * (discountPercent / 100);
  const discountedSubtotal = Math.max(0, subtotal - discountAmount);
  const grandTotal = discountedSubtotal + estimatedFees;

  const discountedCreatorSplit = discountedSubtotal * 0.9;
  const discountedPlatformSplit = discountedSubtotal * 0.1;

  // Validate balance whenever pricing or wallet changes
  useEffect(() => {
    async function checkBalance() {
      if (!walletAddress) {
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const status = await validateCheckoutBalance({ 
          walletAddress, 
          totalPrice: discountedSubtotal, 
          estimatedGas: estimatedFees 
        });
        setBalanceStatus(status);
      } catch (err) {
        console.error("Failed to check balance", err);
      } finally {
        setLoading(false);
      }
    }
    checkBalance();
  }, [walletAddress, discountedSubtotal, estimatedFees]);

  const canCheckout = balanceStatus?.hasEnough;
  const isButtonDisabled = disabled || !canCheckout || loading;

  return (
    <div className="flex flex-col gap-2.5 text-xs text-slate-600 dark:text-slate-300 font-semibold border-b border-slate-200/60 dark:border-slate-800 pb-4">
      {/* Subtotal */}
      <div className="flex justify-between">
        <span className="text-slate-400">Notes Subtotal</span>
        <span className="font-bold text-slate-800 dark:text-slate-100">
          {subtotal.toFixed(2)} XLM
        </span>
      </div>

      {/* Discount line (only when promo applied) */}
      {discountAmount > 0 && (
        <div className="flex justify-between text-emerald-600 dark:text-emerald-400">
          <span className="flex items-center gap-1">
            <span className="text-[9px] bg-emerald-100 dark:bg-emerald-900/40 px-1.5 py-0.5 rounded font-bold uppercase">
              {promoCode.code}
            </span>
            Discount ({discountPercent}%)
          </span>
          <span className="font-bold">
            -{discountAmount.toFixed(2)} XLM
          </span>
        </div>
      )}

      {/* Network fee */}
      <div className="flex justify-between">
        <span className="text-slate-400">Est. Stellar Network Fee</span>
        <span className="font-bold text-slate-800 dark:text-slate-100">
          +{estimatedFees.toFixed(2)} XLM
        </span>
      </div>

      {/* Creator / Platform splits */}
      <div className="mt-1 flex flex-col gap-1 bg-blue-500/5 dark:bg-blue-500/10 px-3 py-2.5 rounded-lg border border-blue-200/20">
        <div className="flex justify-between text-[11px] text-blue-600 dark:text-blue-400 font-bold">
          <span>90% Creator Revenue Split</span>
          <span>{discountedCreatorSplit.toFixed(2)} XLM</span>
        </div>
        <div className="flex justify-between text-[11px] text-slate-500 dark:text-slate-400">
          <span>10% Platform Protocol Split</span>
          <span>{discountedPlatformSplit.toFixed(2)} XLM</span>
        </div>
      </div>

      {/* Promo code input */}
      <div className="mt-1">
        <PromoInput
          onApply={onPromoApply}
          onRemove={onPromoRemove}
          disabled={disabled || loading}
        />
      </div>

      {/* Grand total */}
      <div className="flex justify-between items-baseline mt-1 pt-2 border-t border-slate-200/40 dark:border-slate-800/60">
        <span className="text-sm font-bold text-slate-800 dark:text-slate-100">
          Consolidated Total
        </span>
        <div className="flex flex-col items-end">
          {discountAmount > 0 && (
            <span className="text-[10px] text-slate-400 line-through">
              {subtotal.toFixed(3)} XLM
            </span>
          )}
          <span className="text-lg font-extrabold text-blue-600 dark:text-blue-400">
            {grandTotal.toFixed(3)} XLM
          </span>
        </div>
      </div>

      {/* Insufficient Balance Warning */}
      {!loading && balanceStatus && !canCheckout && (
        <div className="bg-red-50 dark:bg-red-900/20 border-l-4 border-red-500 p-3 mt-3 text-red-700 dark:text-red-400 rounded-r">
          <p className="font-bold text-sm">Insufficient Balance</p>
          <p className="mt-1">Your remaining balance ({balanceStatus.remainingBalance} XLM) is negative.</p>
          <p className="text-[11px] mt-2 opacity-90">
            Please fund your wallet via Friendbot or deposit more XLM to cover the total cost and gas fees before initiating checkout.
          </p>
        </div>
      )}

      {/* Action Button */}
      <button 
        className={`w-full mt-4 py-2.5 rounded-lg font-bold text-white transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none ${
          isButtonDisabled 
            ? 'bg-slate-400 dark:bg-slate-700 cursor-not-allowed' 
            : 'bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600'
        }`}
        disabled={isButtonDisabled}
        onClick={onConfirm}
        aria-busy={loading}
      >
        {loading ? 'Checking Balance...' : 'Initiate Checkout'}
      </button>
    </div>
  );
}