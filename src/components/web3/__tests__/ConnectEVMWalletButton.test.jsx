import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import ConnectEVMWalletButton from "../ConnectEVMWalletButton";

vi.mock("@rainbow-me/rainbowkit", () => ({
  ConnectButton: {
    Custom: ({ children }) =>
      children({
        account: null,
        chain: null,
        openAccountModal: vi.fn(),
        openChainModal: vi.fn(),
        openConnectModal: vi.fn(),
        authenticationStatus: "unauthenticated",
        mounted: true,
      }),
  },
}));

describe("ConnectEVMWalletButton", () => {
  it("renders connect button when no wallet is connected", () => {
    render(<ConnectEVMWalletButton />);
    expect(screen.getByText("Connect EVM wallet")).toBeInTheDocument();
  });

  it("renders wrong network button when chain is unsupported", () => {
    vi.mocked(require("@rainbow-me/rainbowkit").ConnectButton.Custom).mockImplementation(
      ({ children }) =>
        children({
          account: { displayName: "0x1234...5678", address: "0x1234567890123456789012345678901234567890" },
          chain: { unsupported: true, name: "Unknown" },
          openAccountModal: vi.fn(),
          openChainModal: vi.fn(),
          openConnectModal: vi.fn(),
          authenticationStatus: "authenticated",
          mounted: true,
        }),
    );

    render(<ConnectEVMWalletButton />);
    expect(screen.getByText("Wrong network")).toBeInTheDocument();
  });

  it("renders connected state with account info", () => {
    vi.mocked(require("@rainbow-me/rainbowkit").ConnectButton.Custom).mockImplementation(
      ({ children }) =>
        children({
          account: { displayName: "0x1234...5678", address: "0x1234567890123456789012345678901234567890" },
          chain: { unsupported: false, name: "Ethereum", id: 1 },
          openAccountModal: vi.fn(),
          openChainModal: vi.fn(),
          openConnectModal: vi.fn(),
          authenticationStatus: "authenticated",
          mounted: true,
        }),
    );

    render(<ConnectEVMWalletButton />);
    expect(screen.getByText("Ethereum")).toBeInTheDocument();
    expect(screen.getByText("0x1234...5678")).toBeInTheDocument();
  });
});
