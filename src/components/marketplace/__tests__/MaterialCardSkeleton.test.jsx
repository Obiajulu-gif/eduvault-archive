import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import MaterialCardSkeleton from "../MaterialCardSkeleton";

describe("MaterialCardSkeleton", () => {
  it("renders without crashing", () => {
    const { container } = render(<MaterialCardSkeleton />);
    expect(container.firstChild).toBeInTheDocument();
  });

  it("has aria-hidden attribute", () => {
    const { container } = render(<MaterialCardSkeleton />);
    expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
  });

  it("applies animate-pulse class", () => {
    const { container } = render(<MaterialCardSkeleton />);
    expect(container.firstChild).toHaveClass("animate-pulse");
  });

  it("renders image placeholder and content placeholders", () => {
    const { container } = render(<MaterialCardSkeleton />);
    const imagePlaceholder = container.querySelector(".h-36");
    expect(imagePlaceholder).toBeInTheDocument();

    const textPlaceholders = container.querySelectorAll(".h-4, .h-3");
    expect(textPlaceholders.length).toBeGreaterThanOrEqual(4);
  });
});