'use client';

import { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { useToast } from '@/hooks/useToast';
import { purchaseService } from '@/services/purchaseService';
import { useWallet } from '@/hooks/useWallet';
import { useTransactionCenter } from '@/providers/TransactionProvider';
import { useStellarTransaction, readTransactionStatus } from '@/hooks/useStellarTransaction';
import { buildPurchaseTransactionXdr } from '@/lib/stellar/purchaseXdr';
import {
  SigningStage,
  clearCheckoutRecovery,
  readCheckoutRecovery,
  recordCheckoutSigningStage,
  saveCheckoutRecovery,
} from '@/lib/transactions/checkoutRecovery';

export const CartContext = createContext(null);

function itemId(item) {
  return String(item?._id || item?.id || '');
}

/** Only the fields the recovery banner and a fresh checkout need are stored. */
function toRecoveryItems(items) {
  return items
    .filter((item) => itemId(item))
    .map((item) => {
      const id = itemId(item);
      return {
        id,
        title: typeof item.title === 'string' ? item.title : `Material ${id}`,
        ...(item.price !== undefined ? { price: item.price } : {}),
        ...(item.asset !== undefined ? { asset: item.asset } : {}),
      };
    });
}

export function CartProvider({ children }) {
  const [cartItems, setCartItems] = useState([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const toast = useToast();
  const { isConnected, address } = useWallet();
  const { beginTransaction, failTransaction } = useTransactionCenter();
  const { execute, submitSignedTransaction } = useStellarTransaction();

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

  const clearRecovery = useCallback(() => {
    try {
      clearCheckoutRecovery();
    } catch {
      // Storage may be disabled; checkout must still be able to finish.
    }
  }, []);

  /** Recovery bookkeeping is intentionally best-effort and never blocks a payment. */
  const persistStage = useCallback((stage, patch = {}) => {
    try {
      recordCheckoutSigningStage(stage, patch, Date.now());
    } catch {
      // Ignore blocked or corrupt storage.
    }
  }, []);

  const finishCheckout = useCallback((count) => {
    clearRecovery();
    setCartItems([]);
    setIsCartOpen(false);
    toast.show({
      title: 'Checkout Complete',
      message: `${count} purchase${count === 1 ? '' : 's'} confirmed on-chain.`,
      type: 'success',
      duration: 4000,
    });
  }, [clearRecovery, toast]);

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

  /**
   * Runs the actual Stellar purchase flow. `items` and `intent` are accepted
   * so a recovered attempt can resume without depending on React state that
   * was lost when the tab closed.
   */
  const checkout = useCallback(async (email, options = {}) => {
    const items = Array.isArray(options.items) ? options.items : cartItems;
    const previousIntent =
      options.intent && typeof options.intent === 'object' ? options.intent : {};
    const completedIds = Array.isArray(previousIntent.completedItemIds)
      ? [...previousIntent.completedItemIds]
      : [];
    const pendingItems = items.filter((item) => !completedIds.includes(itemId(item)));

    if (pendingItems.length === 0) {
      toast.show({
        title: 'Empty Cart',
        message: 'Add items to your cart before checking out.',
        type: 'info',
        duration: 3000,
      });
      return { status: 'empty' };
    }

    if (!isConnected || !address) {
      toast.show({
        title: 'Wallet Not Connected',
        message: 'Please connect your Stellar wallet to sign the transaction.',
        type: 'error',
        duration: 4000,
      });
      return { status: 'wallet_required' };
    }

    const deliveryEmail = email || previousIntent.email || undefined;

    try {
      saveCheckoutRecovery({
        items: toRecoveryItems(pendingItems),
        walletAddress: address,
        // A fresh checkout gets a fresh quote and signature. Only the delivery
        // email and completed-item progress carry over from an older attempt.
        intent: {
          stage: SigningStage.AwaitingSignature,
          email: deliveryEmail,
          completedItemIds: completedIds,
        },
      });
    } catch {
      // A blocked storage must never stop the checkout itself.
    }

    beginTransaction({
      scope: 'cart',
      title: 'Checkout Confirmation',
      message: `Preparing ${pendingItems.length} Stellar purchase transaction${pendingItems.length === 1 ? '' : 's'} for checkout...`,
    });

    try {
      const confirmedPurchases = [];

      for (const item of pendingItems) {
        const materialId = itemId(item);
        const quote = await purchaseService.createPurchase({
          action: 'quote', buyerAddress: address, materialId,
        });
        const quotedItem = { ...item, price: quote.price, asset: quote.asset };
        const stageContext = {
          materialId,
          title: typeof item.title === 'string' ? item.title : `Material ${materialId}`,
          quoteId: quote.quoteId,
          amount: String(quote.price ?? item.price ?? ''),
          asset: quote.asset ?? item.asset,
          email: deliveryEmail,
          completedItemIds: [...completedIds],
        };
        const unsignedXdr = await buildPurchaseTransactionXdr({
          buyerAddress: address,
          item: quotedItem,
          transactionReference: `cart:${materialId}:${Date.now()}`,
        });
        const { hash } = await execute(unsignedXdr, {
          description: `Purchase ${stageContext.title}`,
          onStage: (stage, patch = {}) =>
            persistStage(stage, {
              ...stageContext,
              ...patch,
              completedItemIds: [...completedIds],
            }),
        });

        const purchase = await purchaseService.createPurchase({
          buyerAddress: address,
          materialId,
          quoteId: quote.quoteId,
          transactionHash: hash,
          email: deliveryEmail,
          amount: quote.price,
          asset: quote.asset,
        });
        confirmedPurchases.push(purchase);
        completedIds.push(materialId);
        persistStage(SigningStage.Submitted, {
          ...stageContext,
          txHash: hash,
          completedItemIds: [...completedIds],
        });
      }

      const totalCount = Number.isFinite(options.totalCount)
        ? options.totalCount
        : confirmedPurchases.length;
      finishCheckout(totalCount);
      return { status: 'complete', purchases: confirmedPurchases };
    } catch (err) {
      console.error('Checkout error:', err);
      failTransaction(err, {
        title: 'Checkout Incomplete',
        message: err?.message || 'The checkout transaction failed or was rejected.',
      });
      // The recovery record is deliberately left at the last recorded stage.
      return { status: 'failed', error: err };
    }
  }, [address, beginTransaction, cartItems, execute, failTransaction, finishCheckout, isConnected, persistStage, toast]);

  const finalizeRecoveredPurchase = useCallback(async ({ item, intent, hash }) => {
    const materialId = intent.materialId || itemId(item);
    if (!intent.quoteId) {
      throw new Error(
        'The saved checkout quote is no longer available. Start the purchase again.',
      );
    }

    return purchaseService.createPurchase({
      buyerAddress: address,
      materialId,
      quoteId: intent.quoteId,
      transactionHash: hash || intent.txHash || null,
      email: intent.email || undefined,
      amount: intent.amount,
      asset: intent.asset,
    });
  }, [address]);

  /**
   * Rebuilds an interrupted cart from its recovery record. The record is only
   * removed after the server has confirmed every purchase, so a failed resume
   * can be retried or handed to verification without losing the transaction
   * hash.
   */
  const resumeCheckout = useCallback(async () => {
    const result = readCheckoutRecovery(Date.now());
    if (result.status !== 'ready') return { status: result.status };

    const record = result.record;
    if (!isConnected || !address) {
      return {
        status: 'wallet_required',
        error: new Error('Connect the original Stellar wallet to resume checkout.'),
      };
    }
    if (record.walletAddress !== address) {
      return {
        status: 'wallet_mismatch',
        error: new Error('This checkout belongs to a different wallet.'),
      };
    }

    const intent = record.intent || {};
    const completedIds = Array.isArray(intent.completedItemIds)
      ? [...intent.completedItemIds]
      : [];
    const pendingItems = (record.items || []).filter(
      (item) => !completedIds.includes(item.id),
    );

    if (pendingItems.length === 0) {
      clearRecovery();
      setCartItems([]);
      return { status: 'complete' };
    }

    const totalCount = completedIds.length + pendingItems.length;
    const current = pendingItems[0];
    const currentId = current.id;
    const email = intent.email || undefined;
    const stageContext = {
      materialId: currentId,
      title: current.title,
      quoteId: intent.quoteId,
      amount: intent.amount,
      asset: intent.asset,
      email,
      completedItemIds: [...completedIds],
    };
    const track = (stage, patch = {}) =>
      persistStage(stage, { ...stageContext, ...patch, completedItemIds: [...completedIds] });

    try {
      if (intent.stage === SigningStage.Signed && intent.signedXdr) {
        // The signature already exists, so resubmit it instead of asking the
        // wallet to sign a second (potentially duplicate) payment.
        const { hash } = await submitSignedTransaction(intent.signedXdr, {
          description: `Purchase ${current.title || currentId}`,
          onStage: track,
        });
        await finalizeRecoveredPurchase({ item: current, intent, hash });
        completedIds.push(currentId);
        track(SigningStage.Confirmed, { txHash: hash });
      } else if (
        (intent.stage === SigningStage.Submitted || intent.stage === SigningStage.Confirmed) &&
        intent.txHash
      ) {
        // The transaction may already be on-chain. Verify before any new
        // signature or purchase request is made.
        const verification = await readTransactionStatus(intent.txHash);
        if (verification.status !== 'SUCCESS') {
          const detail =
            verification.status === 'NOT_FOUND'
              ? 'not visible on the network yet'
              : verification.status.toLowerCase();
          const error = new Error(
            `The saved transaction is ${detail}. Check again before paying again.`,
          );
          failTransaction(error, {
            title: 'Payment not confirmed',
            message: error.message,
            retryable: true,
          });
          return { status: 'needs_verification', error };
        }
        await finalizeRecoveredPurchase({ item: current, intent, hash: intent.txHash });
        completedIds.push(currentId);
        track(SigningStage.Confirmed, { txHash: intent.txHash });
      } else {
        // Nothing reached the network. Restore the remaining items and start
        // a fresh quote/signature for them.
        setCartItems(pendingItems);
        return checkout(email, {
          items: pendingItems,
          intent: { ...intent, completedItemIds: completedIds, email },
          totalCount,
        });
      }

      const remaining = pendingItems.slice(1);
      if (remaining.length > 0) {
        setCartItems(remaining);
        return checkout(email, {
          items: remaining,
          intent: { ...intent, completedItemIds: completedIds, email },
          totalCount,
        });
      }

      finishCheckout(totalCount);
      return { status: 'complete' };
    } catch (err) {
      console.error('Checkout recovery error:', err);
      failTransaction(err, {
        title: 'Checkout recovery incomplete',
        message: err?.message || 'The interrupted checkout could not be completed.',
        retryable: true,
      });
      // Keep the record so the user can retry or verify after fixing the cause.
      return { status: 'failed', error: err };
    }
  }, [address, checkout, clearRecovery, failTransaction, finalizeRecoveredPurchase, finishCheckout, isConnected, persistStage, submitSignedTransaction]);

  const dismissRecovery = useCallback(() => {
    clearRecovery();
  }, [clearRecovery]);

  const value = {
    cartItems,
    isCartOpen,
    setIsCartOpen,
    addToCart,
    removeFromCart,
    clearCart,
    totals,
    checkout,
    resumeCheckout,
    dismissRecovery,
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
