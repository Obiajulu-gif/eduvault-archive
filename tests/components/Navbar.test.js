import { createElement } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import {
    MockWalletProvider,
    MOCK_WALLET_ADDRESS,
    createConnectedWalletValue,
    createDisconnectedWalletValue,
} from '../mocks/stellarWalletContext';

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/hooks/useCart', () => ({
    useCart: () => ({ cartItems: [], setIsCartOpen: vi.fn() }),
}));

vi.mock('@/components/notifications/NotificationCenter', () => ({
    default: () => null,
}));

import Navbar from '@/components/Navbar';

function renderNavbar(walletValue) {
    return render(
        createElement(MockWalletProvider, { value: walletValue }, createElement(Navbar))
    );
}

afterEach(() => {
    cleanup();
});

describe('Navbar — wallet-dependent layout', () => {
    it('renders the connect-wallet prompt when no wallet is connected', () => {
        renderNavbar(createDisconnectedWalletValue());

        expect(screen.getByRole('button', { name: /connect wallet/i })).toBeInTheDocument();
        expect(screen.queryByText(/GDUMMY/)).not.toBeInTheDocument();
    });

    it('renders the connected wallet layout with the formatted dummy address', () => {
        renderNavbar(createConnectedWalletValue());

        const shortAddress = `${MOCK_WALLET_ADDRESS.slice(0, 6)}...${MOCK_WALLET_ADDRESS.slice(-4)}`;
        expect(screen.getByText(shortAddress)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /connect wallet/i })).not.toBeInTheDocument();
    });

    it('reflects a custom connected address passed via the mock context', () => {
        const customAddress = 'GCUSTOMADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
        renderNavbar(createConnectedWalletValue({ address: customAddress }));

        const shortAddress = `${customAddress.slice(0, 6)}...${customAddress.slice(-4)}`;
        expect(screen.getByText(shortAddress)).toBeInTheDocument();
    });
});
