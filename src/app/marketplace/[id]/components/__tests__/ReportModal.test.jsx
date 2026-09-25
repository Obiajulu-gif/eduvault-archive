import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ReportModal from "../ReportModal";

describe("ReportModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when closed", () => {
    const { container } = render(<ReportModal isOpen={false} onClose={vi.fn()} materialId="123" materialTitle="Test" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders form when open", () => {
    render(<ReportModal isOpen={true} onClose={vi.fn()} materialId="123" materialTitle="Test" />);
    expect(screen.getByText("Report Resource")).toBeInTheDocument();
    expect(screen.getByText("Submit Report")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("calls onClose when Cancel is clicked", () => {
    const onClose = vi.fn();
    render(<ReportModal isOpen={true} onClose={onClose} materialId="123" materialTitle="Test" />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows validation error when submitting without reason", () => {
    render(<ReportModal isOpen={true} onClose={vi.fn()} materialId="123" materialTitle="Test" />);
    fireEvent.click(screen.getByText("Submit Report"));
    expect(screen.getByText("Please select a reason for reporting.")).toBeInTheDocument();
  });
});
