import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { FaBookOpen } from "react-icons/fa";
import PreviewBlock from "../PreviewBlock";

describe("PreviewBlock", () => {
  it("renders title and items list", () => {
    render(<PreviewBlock title="Outcomes" items={["A", "B"]} icon={FaBookOpen} />);
    expect(screen.getByText("Outcomes")).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
  });

  it("renders empty state when items is empty", () => {
    render(<PreviewBlock title="Outcomes" items={[]} emptyLabel="No outcomes yet" icon={FaBookOpen} />);
    expect(screen.getByText("No outcomes yet")).toBeInTheDocument();
  });

  it("renders empty state when items is null", () => {
    render(<PreviewBlock title="Outcomes" items={null} emptyLabel="No outcomes yet" icon={FaBookOpen} />);
    expect(screen.getByText("No outcomes yet")).toBeInTheDocument();
  });

  it("renders without icon", () => {
    render(<PreviewBlock title="Details" items={["Item 1"]} />);
    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getByText("Item 1")).toBeInTheDocument();
  });
});
