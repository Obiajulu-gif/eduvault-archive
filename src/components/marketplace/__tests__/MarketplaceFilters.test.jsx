import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";

import MarketplaceFilters from "../MarketplaceFilters";

const defaultProps = {
  subjects: ["All", "Mathematics", "Science"],
  categories: [{ id: "academic", label: "Academic" }],
  subjectsLoading: false,
  searchQuery: "",
  activeSubject: "All",
  activeCategory: "All",
  activeLevel: "",
  sortBy: "Popular",
  onSearchChange: vi.fn(),
  onSubjectChange: vi.fn(),
  onCategoryChange: vi.fn(),
  onLevelChange: vi.fn(),
  onSortByChange: vi.fn(),
  onPageReset: vi.fn(),
};

describe("MarketplaceFilters", () => {
  it("renders search input", () => {
    render(<MarketplaceFilters {...defaultProps} />);
    expect(screen.getByPlaceholderText("Search materials...")).toBeInTheDocument();
  });

  it("renders subject filter select", () => {
    render(<MarketplaceFilters {...defaultProps} />);
    expect(screen.getByLabelText("Filter by subject")).toBeInTheDocument();
  });

  it("renders level filter select", () => {
    render(<MarketplaceFilters {...defaultProps} />);
    expect(screen.getByLabelText("Filter by level")).toBeInTheDocument();
  });

  it("renders sort select", () => {
    render(<MarketplaceFilters {...defaultProps} />);
    expect(screen.getByLabelText("Sort materials")).toBeInTheDocument();
  });

  it("renders mobile subject pills", () => {
    render(<MarketplaceFilters {...defaultProps} />);
    const pills = screen.getAllByRole("tab");
    expect(pills.length).toBeGreaterThan(0);
  });

  it("renders sidebar subject list on desktop", () => {
    render(<MarketplaceFilters {...defaultProps} />);
    expect(screen.getByText("Subjects")).toBeInTheDocument();
    expect(screen.getByText("Categories")).toBeInTheDocument();
  });

  it("calls onSearchChange once after the debounce interval when typing", () => {
    vi.useFakeTimers();
    try {
      const onSearchChange = vi.fn();
      const onPageReset = vi.fn();
      render(
        <MarketplaceFilters
          {...defaultProps}
          onSearchChange={onSearchChange}
          onPageReset={onPageReset}
        />,
      );

      const input = screen.getByPlaceholderText("Search materials...");
      fireEvent.change(input, { target: { value: "calculus" } });

      // Input updates immediately, but the query callback waits for the debounce.
      expect(input).toHaveValue("calculus");
      expect(onSearchChange).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(onSearchChange).toHaveBeenCalledTimes(1);
      expect(onSearchChange).toHaveBeenCalledWith("calculus");
      expect(onPageReset).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("only fires the debounced search for the final value", () => {
    vi.useFakeTimers();
    try {
      const onSearchChange = vi.fn();
      render(<MarketplaceFilters {...defaultProps} onSearchChange={onSearchChange} />);

      const input = screen.getByPlaceholderText("Search materials...");
      fireEvent.change(input, { target: { value: "cal" } });
      act(() => {
        vi.advanceTimersByTime(150);
      });
      fireEvent.change(input, { target: { value: "calculus" } });
      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(onSearchChange).toHaveBeenCalledTimes(1);
      expect(onSearchChange).toHaveBeenCalledWith("calculus");
    } finally {
      vi.useRealTimers();
    }
  });

  it("syncs the input when the search query changes externally", () => {
    const { rerender } = render(<MarketplaceFilters {...defaultProps} searchQuery="algebra" />);
    const input = screen.getByPlaceholderText("Search materials...");
    expect(input).toHaveValue("algebra");

    rerender(<MarketplaceFilters {...defaultProps} searchQuery="" />);
    expect(input).toHaveValue("");
  });

  // The subject tabs render twice (mobile pills + desktop sidebar); jsdom does
  // not apply the lg:hidden CSS, so queries must tolerate both instances.
  it("calls onSubjectChange when subject pill clicked", async () => {
    const user = userEvent.setup();
    const onSubjectChange = vi.fn();
    render(<MarketplaceFilters {...defaultProps} onSubjectChange={onSubjectChange} />);

    const [mobileSciencePill] = screen.getAllByRole("tab", { name: "Science" });
    await user.click(mobileSciencePill);
    expect(onSubjectChange).toHaveBeenCalledWith("Science");
  });

  it("calls onPageReset when subject changes", async () => {
    const user = userEvent.setup();
    const onPageReset = vi.fn();
    render(<MarketplaceFilters {...defaultProps} onPageReset={onPageReset} />);

    const [mobileSciencePill] = screen.getAllByRole("tab", { name: "Science" });
    await user.click(mobileSciencePill);
    expect(onPageReset).toHaveBeenCalled();
  });

  it("shows loading state for subjects", () => {
    render(<MarketplaceFilters {...defaultProps} subjectsLoading={true} />);
    expect(screen.getAllByText("Loading subjects...").length).toBeGreaterThan(0);
  });
});
