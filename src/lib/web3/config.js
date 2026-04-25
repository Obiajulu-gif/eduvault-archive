import { http, createConfig } from 'wagmi';
import { mainnet, sepolia } from 'wagmi/chains';
import { walletConnect, injected, coinbaseWallet } from 'wagmi/connectors';

const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim();

// Define supported chains
export const chains = [mainnet, sepolia];

const connectors = [
  injected({
    shimDisconnect: true,
  }),
  ...(walletConnectProjectId
    ? [
        walletConnect({
          projectId: walletConnectProjectId,
          metadata: {
            name: 'EduVault',
            description: 'Decentralized Educational Materials Sharing Platform',
            url: typeof window !== 'undefined' ? window.location.origin : '',
            icons: ['https://eduvault.com/icon.png'],
          },
          showQrModal: true,
        }),
      ]
    : []),
  coinbaseWallet({
    appName: 'EduVault',
    appLogoUrl: 'https://eduvault.com/icon.png',
  }),
];

// Configure wagmi
export const config = createConfig({
  chains: [mainnet, sepolia],
  connectors,
  transports: {
    [mainnet.id]: http(),
    [sepolia.id]: http(),
  },
});


