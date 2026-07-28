import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { FaImage } from "react-icons/fa";
import PreviewStat from "../PreviewStat";

describe("PreviewStat", () => {
  it("renders label and value", () => {
    render(<PreviewStat label="Cover image" value="Provided" icon={FaImage} />);
    expect(screen.getByText("Cover image")).toBeInTheDocument();
    expect(screen.getByText("Provided")).toBeInTheDocument();
  });

  it("renders without icon", () => {
    render(<PreviewStat label="Label" value="Value" />);
    expect(screen.getByText("Label")).toBeInTheDocument();
    expect(screen.getByText("Value")).toBeInTheDocument();
  });
});
