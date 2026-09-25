import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, beforeEach, vi } from "vitest";

const { kitMock, emitKitEvent } = vi.hoisted(() => {
  const listeners = {};
  const kitMock = {
    init: vi.fn(),
    getAddress: vi.fn(),
    authModal: vi.fn(),
    disconnect: vi.fn(),
    signTransaction: vi.fn(),
    signAuthEntry: vi.fn(),
    on: vi.fn((type, cb) => {
      (listeners[type] ||= []).push(cb);
      return () => {
        listeners[type] = (listeners[type] || []).filter((fn) => fn !== cb);
      };
    }),
  };
  const emitKitEvent = (type, payload) => {
    (listeners[type] || []).forEach((cb) => cb({ payload }));
  };
  return { kitMock, emitKitEvent };
});

vi.mock("@creit-tech/stellar-wallets-kit", () => ({
  StellarWalletsKit: kitMock,
  KitEventType: {
    WALLET_SELECTED: "WALLET_SELECTED",
    STATE_UPDATED: "STATE_UPDATED",
    DISCONNECT: "DISCONNECT",
  },
}));

vi.mock("@creit-tech/stellar-wallets-kit/modules/utils", () => ({
  defaultModules: vi.fn(() => []),
}));

vi.mock("@/lib/wallet/balance", () => ({
  fetchBalances: vi.fn().mockResolvedValue({
    status: "loaded",
    snapshot: { balances: [], native: { assetType: "native", balance: "0" } },
  }),
  BalancesStatus: Object.freeze({
    Idle: "idle",
    Loading: "loading",
    Loaded: "loaded",
    Unfunded: "unfunded",
    Error: "error",
  }),
}));

import { WalletProvider } from "../WalletProvider";
import { useWallet } from "@/hooks/useWallet";
import { NETWORK_PASSPHRASE } from "@/lib/wallet/kit";

const SESSION_STORAGE_KEY = "eduvault.wallet.session.v1";

function Harness() {
  const { state, connect, disconnect } = useWallet();
  const address = state.status === "connected" ? state.session.address : "";
  return (
    <div>
      <div data-testid="status">{state.status}</div>
      <div data-testid="address">{address}</div>
      <button onClick={connect}>connect</button>
      <button onClick={disconnect}>disconnect</button>
    </div>
  );
}

function renderWallet() {
  return render(
    <WalletProvider>
      <Harness />
    </WalletProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("WalletProvider", () => {
  it("auto-connects on mount when the kit already reports an address", async () => {
    kitMock.getAddress.mockResolvedValueOnce({ address: "GAUTO000000000000000000000000000000000000000000000000" });

    renderWallet();

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("connected"));
    expect(screen.getByTestId("address").textContent).toBe(
      "GAUTO000000000000000000000000000000000000000000000000",
    );

    const persisted = JSON.parse(window.localStorage.getItem(SESSION_STORAGE_KEY));
    expect(persisted.address).toBe("GAUTO000000000000000000000000000000000000000000000000");
  });

  it("goes idle when the kit has no address and there is no persisted session", async () => {
    kitMock.getAddress.mockRejectedValueOnce(new Error("no wallet selected"));

    renderWallet();

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("idle"));
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it("intercepts STATE_UPDATED network-change events and flags an unsupported network", async () => {
    kitMock.getAddress.mockRejectedValueOnce(new Error("no wallet selected"));

    renderWallet();
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("idle"));

    act(() => {
      emitKitEvent("STATE_UPDATED", {
        address: "GWRONGNET00000000000000000000000000000000000000000000",
        networkPassphrase: "Some Other Network ; July 2026",
      });
    });

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("unsupported"));
    expect(NETWORK_PASSPHRASE).not.toBe("Some Other Network ; July 2026");
  });

  it("processes STATE_UPDATED with no address as a locked wallet", async () => {
    kitMock.getAddress.mockRejectedValueOnce(new Error("no wallet selected"));

    renderWallet();
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("idle"));

    act(() => {
      emitKitEvent("STATE_UPDATED", { address: null, networkPassphrase: NETWORK_PASSPHRASE });
    });

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("locked"));
  });

  it("disconnect() clears the persisted session and returns to idle", async () => {
    kitMock.getAddress.mockResolvedValueOnce({ address: "GCONNECTED0000000000000000000000000000000000000000000" });
    kitMock.disconnect.mockResolvedValueOnce(undefined);

    renderWallet();
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("connected"));

    fireEvent.click(screen.getByText("disconnect"));

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("idle"));
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });
});
