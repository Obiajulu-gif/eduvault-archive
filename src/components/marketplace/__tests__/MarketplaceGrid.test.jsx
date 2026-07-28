import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";

vi.mock("../MaterialCard", () => ({
  default: ({ material }) => <article data-testid="material-card">{material.title}</article>,
}));

vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...props }) => <div {...props}>{children}</div>,
  },
}));

import MarketplaceGrid from "../MarketplaceGrid";

const sampleMaterials = [
  { _id: "1", title: "Calculus 101", subject: "mathematics", price: 50, fileType: "pdf", likes: 10 },
  { _id: "2", title: "Physics Basics", subject: "science", price: 30, fileType: "pdf", likes: 5 },
];

const defaultProps = {
  isLoading: false,
  isError: false,
  error: null,
  materials: sampleMaterials,
  total: 2,
  activeSubject: "All",
  searchQuery: "",
  cartItems: [],
  comparedItems: [],
  onAddToCart: vi.fn(),
  onAddToComparison: vi.fn(),
  onResetFilters: vi.fn(),
  onBrowseAll: vi.fn(),
  onSearchSubject: vi.fn(),
  currentPage: 1,
  totalPages: 1,
  onPageChange: vi.fn(),
};

describe("MarketplaceGrid", () => {
  it("renders loading skeleton when isLoading", () => {
    render(<MarketplaceGrid {...defaultProps} isLoading={true} materials={[]} />);

    const skeletons = document.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("renders error message when isError", () => {
    render(<MarketplaceGrid {...defaultProps} isError={true} error={new Error("Network failure")} materials={[]} />);

    expect(screen.getByText("Error loading materials")).toBeInTheDocument();
    expect(screen.getByText("Network failure")).toBeInTheDocument();
  });

  it("renders empty state with no materials", () => {
    render(<MarketplaceGrid {...defaultProps} materials={[]} total={0} />);

    expect(screen.getByText("No materials found")).toBeInTheDocument();
    expect(screen.getByText("Clear all filters")).toBeInTheDocument();
    expect(screen.getByText("Browse all materials")).toBeInTheDocument();
  });

  it("renders search-specific empty message when searchQuery is set", () => {
    render(<MarketplaceGrid {...defaultProps} materials={[]} total={0} searchQuery="xyz" />);

    expect(screen.getByText(/No results for "xyz"/)).toBeInTheDocument();
  });

  it("renders material cards when materials exist", () => {
    render(<MarketplaceGrid {...defaultProps} />);

    const cards = screen.getAllByTestId("material-card");
    expect(cards).toHaveLength(2);
    expect(screen.getByText("Calculus 101")).toBeInTheDocument();
    expect(screen.getByText("Physics Basics")).toBeInTheDocument();
  });

  it("shows results count", () => {
    render(<MarketplaceGrid {...defaultProps} />);

    expect(screen.getByText("2 results")).toBeInTheDocument();
  });

  it("shows subject-specific heading when subject is selected", () => {
    render(<MarketplaceGrid {...defaultProps} activeSubject="Science" />);

    expect(screen.getByText("Science Materials")).toBeInTheDocument();
  });

  it("calls onResetFilters when Clear all filters clicked", async () => {
    const user = userEvent.setup();
    const onResetFilters = vi.fn();
    render(<MarketplaceGrid {...defaultProps} materials={[]} total={0} onResetFilters={onResetFilters} />);

    await user.click(screen.getByText("Clear all filters"));
    expect(onResetFilters).toHaveBeenCalled();
  });

  it("calls onBrowseAll when Browse all materials clicked", async () => {
    const user = userEvent.setup();
    const onBrowseAll = vi.fn();
    render(<MarketplaceGrid {...defaultProps} materials={[]} total={0} onBrowseAll={onBrowseAll} />);

    await user.click(screen.getByText("Browse all materials"));
    expect(onBrowseAll).toHaveBeenCalled();
  });

  it("shows suggested subjects in empty state with search query", () => {
    render(<MarketplaceGrid {...defaultProps} materials={[]} total={0} searchQuery="test" />);

    expect(screen.getByText("Math")).toBeInTheDocument();
    expect(screen.getByText("Science")).toBeInTheDocument();
    expect(screen.getByText("Technology")).toBeInTheDocument();
    expect(screen.getByText("Business")).toBeInTheDocument();
  });

  it("renders PaginationBar when totalPages > 1", () => {
    render(<MarketplaceGrid {...defaultProps} totalPages={3} />);

    expect(screen.getByLabelText("Pagination")).toBeInTheDocument();
  });
});
