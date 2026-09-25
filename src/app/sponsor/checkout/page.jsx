"use client";

import React, { useState } from 'react';
import BulkAddressInput from './BulkAddressInput';
import GasEstimator from './GasEstimator';
import ErrorBoundary from '@/components/ErrorBoundary';
import './checkout.css';

/**
 * SponsorCheckout – page component for sponsoring students.
 * Allows bulk entry of Stellar wallet addresses (CSV upload or manual list),
 * validates them client‑side, estimates total transaction volume and Stellar gas
 * costs, and submits the sponsorship.
 */
export default function SponsorCheckout() {
  const [addresses, setAddresses] = useState([]);
  const [valid, setValid] = useState(false);
  const [gasInfo, setGasInfo] = useState({ totalTx: 0, gasCost: 0 });

  const handleAddressesChange = (list) => {
    setAddresses(list);
    const allValid = list.every(addr => /^G[A-Z2-7]{55}$/.test(addr.trim()));
    setValid(allValid && list.length > 0);
    // Simple mock estimation: each address = 1 transaction, gas = 0.00001 XLM per tx
    const totalTx = list.length;
    const gasCost = (totalTx * 0.00001).toFixed(5);
    setGasInfo({ totalTx, gasCost });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!valid) return;
    // In a real app, post to backend. Here we just alert.
    alert(`Sponsoring ${addresses.length} students. Estimated gas: ${gasInfo.gasCost} XLM`);
  };

  return (
    <ErrorBoundary
      fallbackTitle="Checkout error"
      fallbackDescription="Something went wrong during checkout. Please try again or report the issue."
    >
      <section className="sponsor-checkout">
        <h2 className="title">Sponsor a Student – Scholarship Checkout</h2>
        <form onSubmit={handleSubmit} className="checkout-form">
          <BulkAddressInput onChange={handleAddressesChange} />
          <GasEstimator totalTx={gasInfo.totalTx} gasCost={gasInfo.gasCost} />
          <button type="submit" className="submit-btn" disabled={!valid}>
            Confirm Sponsorship
          </button>
        </form>
      </section>
    </ErrorBoundary>
  );
}
