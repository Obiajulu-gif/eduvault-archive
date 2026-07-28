import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import ErrorFallback from "../ErrorFallback";

describe("ErrorFallback", () => {
  it("renders default title, description, and home link", () => {
    render(<ErrorFallback />);
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/");
  });

  it("renders custom title and description", () => {
    render(<ErrorFallback title="Upload failed" description="IPFS is unreachable." />);
    expect(screen.getByRole("heading", { name: "Upload failed" })).toBeInTheDocument();
    expect(screen.getByText("IPFS is unreachable.")).toBeInTheDocument();
  });

  it("shows the underlying error message when provided", () => {
    render(<ErrorFallback error={new Error("HTTP error! status: 502")} />);
    expect(screen.getByTestId("error-detail")).toHaveTextContent("HTTP error! status: 502");
  });

  it("invokes reset when Try again is clicked", () => {
    const reset = vi.fn();
    render(<ErrorFallback reset={reset} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("omits the retry button when no reset handler is given", () => {
    render(<ErrorFallback />);
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });
});
