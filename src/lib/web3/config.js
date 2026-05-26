import { http, createConfig } from 'wagmi';
import { mainnet, sepolia } from 'wagmi/chains';
import { walletConnect, injected, coinbaseWallet } from 'wagmi/connectors';

// WalletConnect Project ID - Get from https://cloud.walletconnect.com/
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'YOUR_PROJECT_ID';

// Define supported chains
export const chains = [mainnet, sepolia];

// Configure wagmi
export const config = createConfig({
  chains: [mainnet, sepolia],
  connectors: [
    // Injected connector (MetaMask, Browser Wallets)
    // Using default injected() without target to detect all injected wallets
    injected({
      shimDisconnect: true,
    }),
    // WalletConnect
    walletConnect({
      projectId,
      metadata: {
        name: 'EduVault',
        description: 'Decentralized Educational Materials Sharing Platform',
        url: typeof window !== 'undefined' ? window.location.origin : '',
        icons: ['https://eduvault.com/icon.png'],
      },
      showQrModal: true,
    }),
    // Coinbase Wallet
    coinbaseWallet({
      appName: 'EduVault',
      appLogoUrl: 'https://eduvault.com/icon.png',
    }),
  ],
  transports: {
    [mainnet.id]: http(),
    [sepolia.id]: http(),
  },
});


