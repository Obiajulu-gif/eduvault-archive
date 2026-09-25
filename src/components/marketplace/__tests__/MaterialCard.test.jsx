import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";

vi.mock("next/image", () => ({
  default: (props) => <img {...props} />,
}));

vi.mock("next/link", () => ({
  default: ({ children, href, className }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

vi.mock("@/components/materials/SaveMaterialButton", () => ({
  default: () => <button data-testid="save-button">Save</button>,
}));

vi.mock("@/components/materials/ResourceStatusBadge", () => ({
  default: () => <span data-testid="status-badge">Status</span>,
}));

import MaterialCard from "../MaterialCard";

const sampleMaterial = {
  _id: "abc123",
  title: "Introduction to Calculus",
  author: "Dr. Smith",
  subject: "mathematics",
  level: "beginner",
  price: 50,
  shortSummary: "A comprehensive guide to calculus",
  averageScore: 4.5,
  feedbackCount: 10,
  likes: 25,
  fileType: "pdf",
  pages: 200,
  userAddress: "GABC123",
};

describe("MaterialCard", () => {
  it("renders title, author, price, and rating", () => {
    render(
      <MaterialCard
        material={sampleMaterial}
        isInCart={false}
        isInComparison={false}
        onAddToCart={vi.fn()}
        onAddToComparison={vi.fn()}
      />
    );

    expect(screen.getByText("Introduction to Calculus")).toBeInTheDocument();
    expect(screen.getByText(/Dr. Smith/)).toBeInTheDocument();
    expect(screen.getByText("50")).toBeInTheDocument();
    expect(screen.getByText("4.5")).toBeInTheDocument();
  });

  it("renders subject and level badges", () => {
    render(
      <MaterialCard
        material={sampleMaterial}
        isInCart={false}
        isInComparison={false}
        onAddToCart={vi.fn()}
        onAddToComparison={vi.fn()}
      />
    );

    expect(screen.getByText("mathematics")).toBeInTheDocument();
    expect(screen.getByText("Beginner")).toBeInTheDocument();
  });

  it("renders file type and likes", () => {
    render(
      <MaterialCard
        material={sampleMaterial}
        isInCart={false}
        isInComparison={false}
        onAddToCart={vi.fn()}
        onAddToComparison={vi.fn()}
      />
    );

    expect(screen.getByText("pdf")).toBeInTheDocument();
    expect(screen.getByText("25")).toBeInTheDocument();
  });

  it("links to the detail page", () => {
    render(
      <MaterialCard
        material={sampleMaterial}
        isInCart={false}
        isInComparison={false}
        onAddToCart={vi.fn()}
        onAddToComparison={vi.fn()}
      />
    );

    const link = screen.getByRole("link", { name: /Introduction to Calculus/ });
    expect(link).toHaveAttribute("href", "/marketplace/abc123");
  });

  it("shows Add to Cart button when not in cart", () => {
    render(
      <MaterialCard
        material={sampleMaterial}
        isInCart={false}
        isInComparison={false}
        onAddToCart={vi.fn()}
        onAddToComparison={vi.fn()}
      />
    );

    expect(screen.getByText("Add to Cart")).toBeInTheDocument();
  });

  it("shows In Cart when item is in cart", () => {
    render(
      <MaterialCard
        material={sampleMaterial}
        isInCart={true}
        isInComparison={false}
        onAddToCart={vi.fn()}
        onAddToComparison={vi.fn()}
      />
    );

    expect(screen.getByText("In Cart")).toBeInTheDocument();
  });

  it("shows Contrast button when not compared", () => {
    render(
      <MaterialCard
        material={sampleMaterial}
        isInCart={false}
        isInComparison={false}
        onAddToCart={vi.fn()}
        onAddToComparison={vi.fn()}
      />
    );

    expect(screen.getByText("Contrast")).toBeInTheDocument();
  });

  it("shows Contrasted when item is in comparison", () => {
    render(
      <MaterialCard
        material={sampleMaterial}
        isInCart={false}
        isInComparison={true}
        onAddToCart={vi.fn()}
        onAddToComparison={vi.fn()}
      />
    );

    expect(screen.getByText("Contrasted")).toBeInTheDocument();
  });

  it("calls onAddToCart when Add to Cart clicked", async () => {
    const user = userEvent.setup();
    const onAddToCart = vi.fn();

    render(
      <MaterialCard
        material={sampleMaterial}
        isInCart={false}
        isInComparison={false}
        onAddToCart={onAddToCart}
        onAddToComparison={vi.fn()}
      />
    );

    await user.click(screen.getByText("Add to Cart"));
    expect(onAddToCart).toHaveBeenCalledWith(sampleMaterial);
  });

  it("calls onAddToComparison when Contrast clicked", async () => {
    const user = userEvent.setup();
    const onAddToComparison = vi.fn();

    render(
      <MaterialCard
        material={sampleMaterial}
        isInCart={false}
        isInComparison={false}
        onAddToCart={vi.fn()}
        onAddToComparison={onAddToComparison}
      />
    );

    await user.click(screen.getByText("Contrast"));
    expect(onAddToComparison).toHaveBeenCalledWith(sampleMaterial);
  });

  it("uses Anonymous when author is missing", () => {
    const materialNoAuthor = { ...sampleMaterial, author: null };
    render(
      <MaterialCard
        material={materialNoAuthor}
        isInCart={false}
        isInComparison={false}
        onAddToCart={vi.fn()}
        onAddToComparison={vi.fn()}
      />
    );

    expect(screen.getByText("Anonymous")).toBeInTheDocument();
  });

  it("renders SaveMaterialButton", () => {
    render(
      <MaterialCard
        material={sampleMaterial}
        isInCart={false}
        isInComparison={false}
        onAddToCart={vi.fn()}
        onAddToComparison={vi.fn()}
      />
    );

    expect(screen.getByTestId("save-button")).toBeInTheDocument();
  });
});
