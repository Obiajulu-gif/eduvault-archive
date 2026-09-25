import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SearchBox, { readSearchHistory } from "../SearchBox";
import { installLocalStorageStub } from "../../../test/mocks/local-storage";

const STORAGE_KEY = "eduvault.searchHistory";

function seedHistory(entries) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

describe("SearchBox history removal", () => {
  beforeEach(() => {
    installLocalStorageStub();
  });

  it("shows saved history with a remove button per entry on focus", () => {
    seedHistory(["soroban", "wallets", "defi"]);
    render(<SearchBox />);
    fireEvent.focus(screen.getByLabelText("Search"));

    expect(screen.getByText("soroban")).toBeInTheDocument();
    expect(screen.getByText("wallets")).toBeInTheDocument();
    expect(
      screen.getByLabelText('Remove "soroban" from search history'),
    ).toBeInTheDocument();
  });

  it("removes only the clicked entry from UI and localStorage", () => {
    seedHistory(["soroban", "wallets", "defi"]);
    render(<SearchBox />);
    fireEvent.focus(screen.getByLabelText("Search"));

    fireEvent.click(screen.getByLabelText('Remove "wallets" from search history'));

    expect(screen.queryByText("wallets")).not.toBeInTheDocument();
    expect(screen.getByText("soroban")).toBeInTheDocument();
    expect(screen.getByText("defi")).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY))).toEqual([
      "soroban",
      "defi",
    ]);
  });

  it("preserves the order of remaining items after removal", () => {
    seedHistory(["one", "two", "three", "four"]);
    render(<SearchBox />);
    fireEvent.focus(screen.getByLabelText("Search"));

    fireEvent.click(screen.getByLabelText('Remove "two" from search history'));

    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["one", "three", "four"]);
  });

  it("keeps the dropdown open after removing an entry", () => {
    seedHistory(["soroban", "wallets"]);
    render(<SearchBox />);
    fireEvent.focus(screen.getByLabelText("Search"));

    fireEvent.click(screen.getByLabelText('Remove "soroban" from search history'));

    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByText("wallets")).toBeInTheDocument();
  });

  it("does not trigger a search when clicking a remove button", () => {
    seedHistory(["soroban"]);
    const onSearch = vi.fn();
    render(<SearchBox onSearch={onSearch} />);
    fireEvent.focus(screen.getByLabelText("Search"));

    fireEvent.click(screen.getByLabelText('Remove "soroban" from search history'));

    expect(onSearch).not.toHaveBeenCalled();
  });

  it("selecting a history entry runs the search", () => {
    seedHistory(["soroban"]);
    const onSearch = vi.fn();
    render(<SearchBox onSearch={onSearch} />);
    fireEvent.focus(screen.getByLabelText("Search"));

    fireEvent.click(screen.getByText("soroban"));

    expect(onSearch).toHaveBeenCalledWith("soroban");
  });

  it("submitting a query records it at the head of history", () => {
    render(<SearchBox />);
    const input = screen.getByLabelText("Search");
    fireEvent.change(input, { target: { value: "escrow" } });
    fireEvent.submit(input.closest("form"));

    expect(readSearchHistory()).toEqual(["escrow"]);
  });

  it("clears all entries from the visible list and localStorage", () => {
    seedHistory(["soroban", "wallets"]);
    render(<SearchBox />);
    fireEvent.focus(screen.getByLabelText("Search"));

    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(readSearchHistory()).toEqual([]);
  });
});
