"use client";

import React from "react";
import Web3TransactionFallback from "@/components/web3/Web3TransactionFallback";

export default class Web3ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("Web3 boundary caught an error", error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
    this.props.onRetry?.();
  };

  render() {
    if (this.state.hasError) {
      return <Web3TransactionFallback error={this.state.error} onRetry={this.handleRetry} />;
    }

    return this.props.children;
  }
}
