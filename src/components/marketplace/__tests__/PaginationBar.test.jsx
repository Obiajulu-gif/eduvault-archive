import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";

import PaginationBar from "../PaginationBar";

describe("PaginationBar", () => {
  it("renders page numbers", () => {
    render(<PaginationBar currentPage={1} totalPages={5} onPageChange={vi.fn()} />);

    for (let i = 1; i <= 5; i++) {
      expect(screen.getByText(String(i))).toBeInTheDocument();
    }
  });

  it("highlights current page", () => {
    render(<PaginationBar currentPage={3} totalPages={5} onPageChange={vi.fn()} />);

    const page3 = screen.getByText("3");
    expect(page3).toHaveAttribute("aria-current", "page");
  });

  it("does not highlight other pages", () => {
    render(<PaginationBar currentPage={3} totalPages={5} onPageChange={vi.fn()} />);

    expect(screen.getByText("1")).not.toHaveAttribute("aria-current");
    expect(screen.getByText("5")).not.toHaveAttribute("aria-current");
  });

  it("calls onPageChange when a page is clicked", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();

    render(<PaginationBar currentPage={1} totalPages={5} onPageChange={onPageChange} />);

    await user.click(screen.getByText("3"));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it("returns null when totalPages is 1", () => {
    const { container } = render(
      <PaginationBar currentPage={1} totalPages={1} onPageChange={vi.fn()} />
    );

    expect(container.innerHTML).toBe("");
  });

  it("has accessible navigation label", () => {
    render(<PaginationBar currentPage={1} totalPages={3} onPageChange={vi.fn()} />);

    expect(screen.getByLabelText("Pagination")).toBeInTheDocument();
  });
});
