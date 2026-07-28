"use client";

import React, { useState, useEffect } from "react";
import { measureNodeLatency, getConfiguredEndpoints } from "@/lib/stellar/horizonClient";
import { FaWifi, FaExclamationTriangle, FaCheckCircle, FaTimesCircle } from "react-icons/fa";

/**
 * NetworkWarning component displaying visual Stellar RPC node latency indicator.
 * Meets requirements for Issue #354.
 */
export default function NetworkWarning({ className = "" }) {
  const [nodeState, setNodeState] = useState({
    latencyMs: null,
    isOnline: true,
    status: 'green',
    url: 'Primary Horizon',
  });
  const [isLoading, setIsLoading] = useState(true);

  const checkNetwork = async () => {
    try {
      const endpoints = getConfiguredEndpoints();
      const primary = endpoints[0] || 'https://horizon-testnet.stellar.org';
      const result = await measureNodeLatency(primary);
      setNodeState(result);
    } catch {
      setNodeState({
        latencyMs: null,
        isOnline: false,
        status: 'red',
        url: 'Horizon Network',
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    checkNetwork();
    // Update latency every 30 seconds as specified in acceptance criteria
    const interval = setInterval(checkNetwork, 30000);
    return () => clearInterval(interval);
  }, []);

  const getStatusColor = () => {
    if (!nodeState.isOnline || nodeState.status === 'red') return 'bg-red-500 text-white border-red-600';
    if (nodeState.status === 'yellow') return 'bg-amber-500 text-white border-amber-600';
    return 'bg-emerald-600 text-white border-emerald-700';
  };

  const getBadgeStyle = () => {
    if (!nodeState.isOnline || nodeState.status === 'red') return 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300';
    if (nodeState.status === 'yellow') return 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300';
    return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300';
  };

  return (
    <div className={`w-full text-xs font-medium ${className}`}>
      <div className={`flex items-center justify-between px-4 py-2 rounded-lg border shadow-sm transition-all ${getBadgeStyle()}`}>
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${
            nodeState.status === 'green' ? 'bg-emerald-500 animate-pulse' :
            nodeState.status === 'yellow' ? 'bg-amber-500' : 'bg-red-500'
          }`} />
          
          <span className="font-semibold">Stellar Horizon Network:</span>

          {isLoading ? (
            <span className="opacity-75">Measuring latency...</span>
          ) : !nodeState.isOnline ? (
            <span className="font-semibold flex items-center gap-1 text-red-600 dark:text-red-400">
              <FaTimesCircle /> Node Connection Dropped — Using Failover Fallback
            </span>
          ) : nodeState.status === 'green' ? (
            <span className="flex items-center gap-1">
              <FaCheckCircle className="text-emerald-600 dark:text-emerald-400" /> Optimal ({nodeState.latencyMs}ms)
            </span>
          ) : nodeState.status === 'yellow' ? (
            <span className="flex items-center gap-1">
              <FaExclamationTriangle className="text-amber-600 dark:text-amber-400" /> Moderate Congestion ({nodeState.latencyMs}ms)
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <FaExclamationTriangle className="text-red-600 dark:text-red-400" /> High Latency ({nodeState.latencyMs}ms)
            </span>
          )}
        </div>

        <div className="text-[11px] opacity-80 hidden sm:block">
          Auto-updates every 30s
        </div>
      </div>
    </div>
  );
}
