import { render, screen } from "@testing-library/react";
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

  it("calls onSearchChange when typing in search", async () => {
    const user = userEvent.setup();
    const onSearchChange = vi.fn();
    render(<MarketplaceFilters {...defaultProps} onSearchChange={onSearchChange} />);

    const input = screen.getByPlaceholderText("Search materials...");
    await user.type(input, "calculus");
    expect(onSearchChange).toHaveBeenCalled();
  });

  it("calls onSubjectChange when subject pill clicked", async () => {
    const user = userEvent.setup();
    const onSubjectChange = vi.fn();
    render(<MarketplaceFilters {...defaultProps} onSubjectChange={onSubjectChange} />);

    const sciencePill = screen.getByRole("tab", { name: "Science" });
    await user.click(sciencePill);
    expect(onSubjectChange).toHaveBeenCalledWith("Science");
  });

  it("calls onPageReset when subject changes", async () => {
    const user = userEvent.setup();
    const onPageReset = vi.fn();
    render(<MarketplaceFilters {...defaultProps} onPageReset={onPageReset} />);

    const sciencePill = screen.getByRole("tab", { name: "Science" });
    await user.click(sciencePill);
    expect(onPageReset).toHaveBeenCalled();
  });

  it("shows loading state for subjects", () => {
    render(<MarketplaceFilters {...defaultProps} subjectsLoading={true} />);
    expect(screen.getByText("Loading subjects...")).toBeInTheDocument();
  });
});
