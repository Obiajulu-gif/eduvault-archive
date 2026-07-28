import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CreatorInventory from "../dashboard/CreatorInventory";
import { installLocalStorageStub } from "../../../test/mocks/local-storage";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const MATERIALS = [
  { _id: "mat-1", title: "Intro to Soroban", visibility: "public", price: 5 },
  { _id: "mat-2", title: "Stellar Basics", visibility: "public", price: 0 },
];

function mockFetchMaterials() {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ materials: MATERIALS, total: 2, totalPages: 1 }),
  });
}

describe("CreatorInventory archive flow", () => {
  beforeEach(() => {
    installLocalStorageStub();
    mockFetchMaterials();
  });

  it("shows an Archive action on each resource", async () => {
    render(<CreatorInventory />);
    await waitFor(() => expect(screen.getByText("Intro to Soroban")).toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: "Archive" })).toHaveLength(2);
  });

  it("hides an archived resource from the default listing", async () => {
    render(<CreatorInventory />);
    await waitFor(() => expect(screen.getByText("Intro to Soroban")).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole("button", { name: "Archive" })[0]);

    expect(screen.queryByText("Intro to Soroban")).not.toBeInTheDocument();
    expect(screen.getByText("Stellar Basics")).toBeInTheDocument();
  });

  it("shows archived status and restore action when Show archived is on", async () => {
    render(<CreatorInventory />);
    await waitFor(() => expect(screen.getByText("Intro to Soroban")).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole("button", { name: "Archive" })[0]);
    fireEvent.click(screen.getByLabelText("Show archived"));

    expect(screen.getByText("Intro to Soroban")).toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
  });

  it("restore returns the resource to the default listing", async () => {
    render(<CreatorInventory />);
    await waitFor(() => expect(screen.getByText("Intro to Soroban")).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole("button", { name: "Archive" })[0]);
    fireEvent.click(screen.getByLabelText("Show archived"));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    fireEvent.click(screen.getByLabelText("Show archived"));

    expect(screen.getByText("Intro to Soroban")).toBeInTheDocument();
    expect(screen.queryByText("Archived")).not.toBeInTheDocument();
  });

  it("persists archive state across mounts", async () => {
    const { unmount } = render(<CreatorInventory />);
    await waitFor(() => expect(screen.getByText("Intro to Soroban")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Archive" })[0]);
    unmount();

    render(<CreatorInventory />);
    await waitFor(() => expect(screen.getByText("Stellar Basics")).toBeInTheDocument());
    expect(screen.queryByText("Intro to Soroban")).not.toBeInTheDocument();
  });
});
