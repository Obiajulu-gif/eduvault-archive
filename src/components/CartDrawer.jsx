'use client';

import { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FaTimes, FaShoppingCart, FaTrash, FaMailBulk } from 'react-icons/fa';
import Image from 'next/image';
import { useCart } from '@/hooks/useCart';
import { useWallet } from '@/hooks/useWallet';
import CheckoutInvoice from '@/components/CheckoutInvoice';

export default function CartDrawer() {
  const {
    cartItems,
    isCartOpen,
    setIsCartOpen,
    removeFromCart,
    totals,
    checkout,
  } = useCart();

  const { isConnected, connect } = useWallet();
  const [email, setEmail] = useState('');
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const [promoCode, setPromoCode] = useState(null);

  const handlePromoApply = useCallback((promoData) => {
    setPromoCode(promoData);
  }, []);

  const handlePromoRemove = useCallback(() => {
    setPromoCode(null);
  }, []);

  const handleCheckoutClick = async () => {
    if (!isConnected) {
      connect();
      return;
    }
    
    setIsCheckingOut(true);
    await checkout(email);
    setIsCheckingOut(false);
  };

  return (
    <AnimatePresence>
      {isCartOpen && (
        <>
          {/* Overlay backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.5 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsCartOpen(false)}
            className="fixed inset-0 bg-slate-950 backdrop-blur-xs z-50 pointer-events-auto"
          />

          {/* Slide-out Drawer Panel */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 220 }}
            className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col z-50 pointer-events-auto"
          >
            {/* Header */}
            <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-slate-50 dark:bg-slate-900/50">
              <div className="flex items-center gap-2.5">
                <div className="relative p-2 bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-lg">
                  <FaShoppingCart />
                  {cartItems.length > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 bg-blue-600 text-white font-extrabold text-[10px] w-5 h-5 rounded-full flex items-center justify-center border border-white dark:border-slate-900">
                      {cartItems.length}
                    </span>
                  )}
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">
                    Your Learning Drawer
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Compile selections for a single transaction
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsCartOpen(false)}
                className="p-2 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
                aria-label="Close cart"
              >
                <FaTimes className="w-4 h-4" />
              </button>
            </div>

            {/* Cart Items List */}
            <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
              {cartItems.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center py-12">
                  <div className="w-16 h-16 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center mb-4">
                    <FaShoppingCart className="text-slate-400 w-6 h-6" />
                  </div>
                  <h4 className="text-sm font-bold text-slate-800 dark:text-slate-100 mb-1">
                    Your cart is empty
                  </h4>
                  <p className="text-xs text-slate-400 max-w-[200px] mb-4">
                    Browse the academic marketplace to add helpful notes and slides.
                  </p>
                  <button
                    onClick={() => setIsCartOpen(false)}
                    className="text-xs font-bold text-blue-600 hover:text-blue-700 hover:underline"
                  >
                    Start Browsing &rarr;
                  </button>
                </div>
              ) : (
                cartItems.map((item) => {
                  const itemId = item._id || item.id;
                  return (
                    <motion.div
                      key={itemId}
                      layout
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      className="flex items-center gap-3.5 p-3 rounded-xl border border-slate-100 dark:border-slate-800/80 hover:border-slate-200 dark:hover:border-slate-800 transition-colors bg-slate-50/50 dark:bg-slate-800/30"
                    >
                      {/* Thumbnail */}
                      <div className="relative w-14 h-14 rounded-lg overflow-hidden bg-slate-100 shrink-0 border border-slate-200/50">
                        <Image
                          src={item.image || item.thumbnailUrl || '/images/image1.jpg'}
                          alt={item.title}
                          fill
                          className="object-cover"
                        />
                      </div>
                      
                      {/* Title & Author */}
                      <div className="flex-1 min-w-0">
                        <h4 className="text-xs font-bold text-slate-800 dark:text-slate-100 leading-tight line-clamp-2">
                          {item.title}
                        </h4>
                        <span className="text-[10px] text-slate-400 font-semibold truncate block mt-0.5">
                          by {item.author || 'Anonymous'}
                        </span>
                      </div>

                      {/* Price & Delete */}
                      <div className="flex flex-col items-end gap-1.5 shrink-0">
                        <span className="text-xs font-extrabold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 px-2 py-0.5 rounded border border-blue-100/50 dark:border-blue-950">
                          {item.price} XLM
                        </span>
                        <button
                          onClick={() => removeFromCart(itemId)}
                          className="text-slate-400 hover:text-rose-500 p-1 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors"
                          title="Remove item"
                        >
                          <FaTrash className="w-3 h-3" />
                        </button>
                      </div>
                    </motion.div>
                  );
                })
              )}
            </div>

            {/* Calculations & Checkout Form (Only visible if items exist) */}
            {cartItems.length > 0 && (
              <div className="border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 p-6 flex flex-col gap-4">
                {/* Checkout Invoice with Promo Support */}
                <CheckoutInvoice
                  subtotal={totals.subtotal}
                  estimatedFees={totals.estimatedFees}
                  creatorSplit={totals.creatorSplit}
                  platformSplit={totals.platformSplit}
                  promoCode={promoCode}
                  onPromoApply={handlePromoApply}
                  onPromoRemove={handlePromoRemove}
                  disabled={isCheckingOut}
                />

                {/* Email address field */}
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="checkout-email" className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    DELIVERY EMAIL ADDRESS
                  </label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center text-slate-400 pointer-events-none">
                      <FaMailBulk className="w-3.5 h-3.5" />
                    </span>
                    <input
                      id="checkout-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="e.g. learner@eduvault.org"
                      className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 pl-10 pr-4 py-2 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 text-slate-800 dark:text-slate-100 transition-all font-medium"
                    />
                  </div>
                </div>

                {/* Checkout/Wallet Action Button */}
                <button
                  onClick={handleCheckoutClick}
                  disabled={isCheckingOut || !email || !email.includes('@')}
                  className="w-full bg-blue-600 hover:bg-blue-700 active:scale-[0.98] disabled:opacity-50 text-white font-bold text-xs py-3 rounded-xl shadow-lg shadow-blue-500/25 transition-all flex items-center justify-center gap-2"
                >
                  {isCheckingOut ? (
                    <>
                      <svg className="animate-spin h-4 w-4 text-white shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Signing Consolidated Transaction...
                    </>
                  ) : !isConnected ? (
                    'Connect Wallet to Checkout'
                  ) : (
                    'Consolidated Checkout (1 Transaction)'
                  )}
                </button>
                
                {!email.includes('@') && (
                  <span className="text-[10px] text-center text-slate-400 font-semibold italic">
                    Please provide a valid delivery email to checkout
                  </span>
                )}
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
