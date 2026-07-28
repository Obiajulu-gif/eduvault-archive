'use client';

import { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { useToast } from '@/hooks/useToast';
import { purchaseService } from '@/services/purchaseService';
import { useWallet } from '@/hooks/useWallet';
import { isMainnet } from '@/lib/config/chain';
import { useTransactionCenter } from '@/providers/TransactionProvider';
import { TransactionStatus } from '@/lib/transactions/transaction';

export const CartContext = createContext(null);

export function CartProvider({ children }) {
  const [cartItems, setCartItems] = useState([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const toast = useToast();
  const { isConnected, address } = useWallet();
  const { beginTransaction, markStatus, confirmTransaction, failTransaction } = useTransactionCenter();

  const addToCart = useCallback((material) => {
    const materialId = material._id || material.id;
    if (!materialId) return;

    setCartItems((prev) => {
      if (prev.some((item) => (item._id || item.id) === materialId)) {
        toast.show({
          title: 'Already in Cart',
          message: `"${material.title}" is already in your cart.`,
          type: 'info',
          duration: 3000,
        });
        return prev;
      }

      toast.show({
        title: 'Added to Cart',
        message: `"${material.title}" added successfully.`,
        type: 'success',
        duration: 3000,
      });

      return [...prev, material];
    });
  }, [toast]);

  const removeFromCart = useCallback((id) => {
    setCartItems((prev) => {
      const removed = prev.find((item) => (item._id || item.id) === id);
      if (removed) {
        toast.show({
          title: 'Removed from Cart',
          message: `"${removed.title}" removed.`,
          type: 'info',
          duration: 2000,
        });
      }
      return prev.filter((item) => (item._id || item.id) !== id);
    });
  }, [toast]);

  const clearCart = useCallback(() => {
    setCartItems([]);
  }, []);

  // calculations
  const totals = useMemo(() => {
    const subtotal = cartItems.reduce((acc, item) => acc + Number(item.price || 0), 0);
    const estimatedFees = 0.01; // static XLM transaction fee
    const grandTotal = subtotal + estimatedFees;

    // Platform split: 90% Creator, 10% Platform
    const creatorSplit = subtotal * 0.9;
    const platformSplit = subtotal * 0.1;

    return {
      subtotal: Number(subtotal.toFixed(2)),
      estimatedFees: Number(estimatedFees.toFixed(3)),
      grandTotal: Number(grandTotal.toFixed(3)),
      creatorSplit: Number(creatorSplit.toFixed(2)),
      platformSplit: Number(platformSplit.toFixed(2)),
    };
  }, [cartItems]);

  const checkout = useCallback(async (email) => {
    if (cartItems.length === 0) {
      toast.show({
        title: 'Empty Cart',
        message: 'Add items to your cart before checking out.',
        type: 'info',
        duration: 3000,
      });
      return;
    }

    if (!isConnected || !address) {
      toast.show({
        title: 'Wallet Not Connected',
        message: 'Please connect your Stellar wallet to sign the transaction.',
        type: 'error',
        duration: 4000,
      });
      return;
    }

    beginTransaction({
      title: 'Checkout Confirmation',
      message: 'Preparing single consolidated Stellar transaction for checkout...',
    });

    try {
      // Simulate Stellar transaction signing delay
      markStatus(TransactionStatus.Signing, {
        title: 'Requesting Signature',
        message: 'Awaiting signature for consolidated Stellar purchase contract in wallet...',
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Simulate Stellar Soroban smart contract purchase broadcasting
      markStatus(TransactionStatus.Submitting, {
        title: 'Broadcasting Transaction',
        message: `Broadcasting transaction to Soroban ${isMainnet ? 'mainnet' : 'testnet'} validators...`,
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      
      const simulatedHash = 'simulated_cart_hash_' + Math.random().toString(36).substring(7);

      markStatus(TransactionStatus.PendingConfirmation, {
        title: 'Confirming Transaction',
        message: 'Waiting for ledger confirmation...',
        txHash: simulatedHash,
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Save each purchase to the database
      const purchasePromises = cartItems.map((item) => {
        const materialId = item._id || item.id;
        return purchaseService.createPurchase({
          buyerAddress: address,
          materialId,
          transactionHash: simulatedHash,
          email: email || undefined,
        });
      });

      await Promise.all(purchasePromises);

      // Success
      confirmTransaction({
        title: 'Transaction Success',
        message: `Consolidated purchase of ${cartItems.length} materials confirmed on-chain!`,
        txHash: simulatedHash,
      });

      setCartItems([]);
      setIsCartOpen(false);
    } catch (err) {
      console.error('Checkout error:', err);
      failTransaction(err, {
        title: 'Transaction Rejected',
        message: err?.message || 'The checkout transaction failed or was rejected.',
      });
    }
  }, [cartItems, isConnected, address, toast, beginTransaction, markStatus, confirmTransaction, failTransaction]);

  const value = {
    cartItems,
    isCartOpen,
    setIsCartOpen,
    addToCart,
    removeFromCart,
    clearCart,
    totals,
    checkout,
  };

  return (
    <CartContext.Provider value={value}>
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error('useCart must be used within a CartProvider');
  }
  return context;
}
