import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import LibraryList, { sortAndFilterLibrary } from "../dashboard/LibraryList";

const ITEMS = [
  {
    _id: "a",
    title: "Advanced Soroban",
    creatorName: "Zara",
    resourceType: "video",
    purchasedAt: "2026-03-01T00:00:00Z",
  },
  {
    _id: "b",
    title: "Stellar Basics",
    creatorName: "Amara",
    resourceType: "pdf",
    purchasedAt: "2026-05-01T00:00:00Z",
  },
  {
    _id: "c",
    title: "Wallet Security",
    creatorName: "Ben",
    resourceType: "pdf",
    purchasedAt: "2026-01-01T00:00:00Z",
  },
];

function renderedTitles() {
  return screen
    .getAllByRole("row")
    .slice(1) // skip header row
    .map((row) => within(row).getAllByRole("cell")[0].textContent);
}

describe("sortAndFilterLibrary", () => {
  it("sorts by purchase date newest first by default", () => {
    const out = sortAndFilterLibrary(ITEMS, "date-desc", "");
    expect(out.map((i) => i._id)).toEqual(["b", "a", "c"]);
  });

  it("sorts by purchase date oldest first", () => {
    const out = sortAndFilterLibrary(ITEMS, "date-asc", "");
    expect(out.map((i) => i._id)).toEqual(["c", "a", "b"]);
  });

  it("sorts by creator name", () => {
    const out = sortAndFilterLibrary(ITEMS, "creator", "");
    expect(out.map((i) => i.creatorName)).toEqual(["Amara", "Ben", "Zara"]);
  });

  it("sorts by resource type", () => {
    const out = sortAndFilterLibrary(ITEMS, "type", "");
    expect(out.map((i) => i.resourceType)).toEqual(["pdf", "pdf", "video"]);
  });

  it("filters case-insensitively across title and creator", () => {
    expect(sortAndFilterLibrary(ITEMS, "date-desc", "STELLAR")).toHaveLength(1);
    expect(sortAndFilterLibrary(ITEMS, "date-desc", "zara")).toHaveLength(1);
    expect(sortAndFilterLibrary(ITEMS, "date-desc", "nomatch")).toHaveLength(0);
  });

  it("does not mutate the input array", () => {
    const input = [...ITEMS];
    sortAndFilterLibrary(input, "creator", "");
    expect(input.map((i) => i._id)).toEqual(["a", "b", "c"]);
  });
});

describe("LibraryList", () => {
  it("re-orders immediately when the sort option changes", () => {
    render(<LibraryList items={ITEMS} />);
    expect(renderedTitles()).toEqual(["Stellar Basics", "Advanced Soroban", "Wallet Security"]);

    fireEvent.change(screen.getByLabelText("Sort library items"), {
      target: { value: "creator" },
    });
    expect(renderedTitles()).toEqual(["Stellar Basics", "Wallet Security", "Advanced Soroban"]);
  });

  it("filters as the user types, case-insensitively", () => {
    render(<LibraryList items={ITEMS} />);
    fireEvent.change(screen.getByLabelText("Search your library"), {
      target: { value: "WALLET" },
    });
    expect(renderedTitles()).toEqual(["Wallet Security"]);
  });

  it("shows an empty state when nothing matches", () => {
    render(<LibraryList items={ITEMS} />);
    fireEvent.change(screen.getByLabelText("Search your library"), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No materials match your search.")).toBeInTheDocument();
  });

  it("shows the empty-library state when there are no items", () => {
    render(<LibraryList items={[]} />);
    expect(screen.getByText("No materials in your library yet.")).toBeInTheDocument();
  });
});
