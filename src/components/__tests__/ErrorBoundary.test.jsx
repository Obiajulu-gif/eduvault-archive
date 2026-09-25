import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";

import ErrorBoundary from "../ErrorBoundary";

const ErrorThrower = () => {
  throw new Error("Test error message");
};

describe("ErrorBoundary", () => {
  it("renders children when no error occurs", () => {
    render(
      <ErrorBoundary>
        <div>Child content</div>
      </ErrorBoundary>,
    );

    expect(screen.getByText("Child content")).toBeInTheDocument();
  });

  it("renders fallback UI when child throws", () => {
    render(
      <ErrorBoundary>
        <ErrorThrower />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("Test error message")).toBeInTheDocument();
    expect(screen.getByText("Try again")).toBeInTheDocument();
    expect(screen.getByText("Report issue")).toBeInTheDocument();
  });

  it("shows custom title and description", () => {
    render(
      <ErrorBoundary
        fallbackTitle="Custom title"
        fallbackDescription="Custom description"
      >
        <ErrorThrower />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Custom title")).toBeInTheDocument();
    expect(screen.getByText("Custom description")).toBeInTheDocument();
  });

  it("calls onRetry and resets when Try again clicked", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();

    render(
      <ErrorBoundary onRetry={onRetry}>
        <ErrorThrower />
      </ErrorBoundary>,
    );

    await user.click(screen.getByText("Try again"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("displays troubleshooting steps", () => {
    render(
      <ErrorBoundary>
        <ErrorThrower />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Troubleshooting steps")).toBeInTheDocument();
    expect(screen.getByText(/Refresh the page/)).toBeInTheDocument();
  });
});