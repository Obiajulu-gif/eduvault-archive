'use client';

import { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { useToast } from '@/hooks/useToast';
import { purchaseService } from '@/services/purchaseService';
import { useWallet } from '@/hooks/useWallet';
import { useTransactionCenter } from '@/providers/TransactionProvider';
import { useStellarTransaction } from '@/hooks/useStellarTransaction';
import { buildPurchaseTransactionXdr } from '@/lib/stellar/purchaseXdr';

export const CartContext = createContext(null);

export function CartProvider({ children }) {
  const [cartItems, setCartItems] = useState([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const toast = useToast();
  const { isConnected, address } = useWallet();
  const { beginTransaction, failTransaction } = useTransactionCenter();
  const { execute } = useStellarTransaction();

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
      scope: 'cart',
      title: 'Checkout Confirmation',
      message: `Preparing ${cartItems.length} Stellar purchase transaction${cartItems.length === 1 ? '' : 's'} for checkout...`,
    });

    try {
      const confirmedPurchases = [];

      for (const item of cartItems) {
        const materialId = item._id || item.id;
        const quote = await purchaseService.createPurchase({
          action: 'quote', buyerAddress: address, materialId,
        });
        const quotedItem = { ...item, price: quote.price, asset: quote.asset };
        const unsignedXdr = await buildPurchaseTransactionXdr({
          buyerAddress: address,
          item: quotedItem,
          transactionReference: `cart:${materialId}:${Date.now()}`,
        });
        const { hash } = await execute(unsignedXdr, {
          description: `Purchase ${item.title || materialId}`,
        });

        const purchase = await purchaseService.createPurchase({
          buyerAddress: address,
          materialId,
          quoteId: quote.quoteId,
          transactionHash: hash,
          email: email || undefined,
          amount: quote.price,
          asset: quote.asset,
        });
        confirmedPurchases.push(purchase);
      }

      setCartItems([]);
      setIsCartOpen(false);
      toast.show({
        title: 'Checkout Complete',
        message: `${confirmedPurchases.length} purchase${confirmedPurchases.length === 1 ? '' : 's'} confirmed on-chain.`,
        type: 'success',
        duration: 4000,
      });
    } catch (err) {
      console.error('Checkout error:', err);
      failTransaction(err, {
        title: 'Checkout Incomplete',
        message: err?.message || 'The checkout transaction failed or was rejected.',
      });
    }
  }, [cartItems, isConnected, address, toast, beginTransaction, execute, failTransaction]);

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
