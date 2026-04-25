import { useAccount, useBalance, useChainId, useConnect, useDisconnect, useSwitchChain } from "wagmi";

/**
 * useWallet Hook
 *
 * Custom hook that provides comprehensive wallet functionality and state management.
 * Encapsulates wagmi hooks for easier use throughout the application.
 *
 * @returns {Object} Wallet state and methods
 */
export function useWallet() {
	const { address, isConnected, isConnecting, isReconnecting, connector } = useAccount();
	const { connect, connectors, error: connectError, isPending } = useConnect();
	const { disconnect } = useDisconnect();
	const chainId = useChainId();
	const { switchChain } = useSwitchChain();

	// Get balance for the connected account
	const { data: balance, isLoading: isBalanceLoading } = useBalance({
		address,
		enabled: !!address,
	});

	/**
	 * Connect to a specific wallet connector
	 * @param {Object} connector - The connector to use (MetaMask, WalletConnect, etc.)
	 */
	const connectWallet = async (walletConnector) => {
		try {
			await connect({ connector: walletConnector });
		} catch (err) {
			console.error("Error connecting wallet:", err);
			throw err;
		}
	};

	/**
	 * Disconnect the currently connected wallet
	 */
	const disconnectWallet = async () => {
		try {
			await disconnect();
		} catch (err) {
			console.error("Error disconnecting wallet:", err);
		}
	};

	/**
	 * Switch to a different blockchain network
	 * @param {number} newChainId - The chain ID to switch to
	 */
	const switchNetwork = async (newChainId) => {
		try {
			await switchChain({ chainId: newChainId });
		} catch (err) {
			console.error("Error switching network:", err);
			throw err;
		}
	};

	/**
	 * Get the name of the current connector
	 * @returns {string} Connector name
	 */
	const getConnectorName = () => {
		if (!connector) return null;
		return connector.name;
	};

	return {
		// Connection state
		address,
		isConnected,
		isConnecting: isConnecting || isPending || isReconnecting,

		// Balance
		balance: balance?.formatted,
		balanceSymbol: balance?.symbol,
		isBalanceLoading,

		// Network
		chainId,

		// Available connectors
		connectors,
		currentConnector: connector,
		connectorName: getConnectorName(),

		// Methods
		connectWallet,
		disconnectWallet,
		switchNetwork,

		// Errors
		error: connectError,
	};
}
