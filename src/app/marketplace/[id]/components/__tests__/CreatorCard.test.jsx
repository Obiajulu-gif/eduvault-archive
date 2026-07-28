import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import CreatorCard from "../CreatorCard";

describe("CreatorCard", () => {
  it("renders creator name, institution, and verified badge", () => {
    render(
      <CreatorCard
        author={{ name: "John Doe", institution: "MIT", level: "Advanced", verified: true, department: "Engineering" }}
        createdAt="2024-01-15T00:00:00Z"
      />,
    );
    expect(screen.getByText("John Doe")).toBeInTheDocument();
    expect(screen.getByText("MIT")).toBeInTheDocument();
    expect(screen.getByText("Advanced")).toBeInTheDocument();
    expect(screen.getByText("Verified creator")).toBeInTheDocument();
    expect(screen.getByText("Engineering")).toBeInTheDocument();
  });

  it("shows unverified badge when not verified", () => {
    render(<CreatorCard author={{ name: "Jane", verified: false }} />);
    expect(screen.getByText("Creator profile unverified")).toBeInTheDocument();
  });

  it("handles missing author gracefully", () => {
    render(<CreatorCard />);
    expect(screen.getByText("Anonymous creator")).toBeInTheDocument();
    expect(screen.getByText("Independent educator")).toBeInTheDocument();
  });
});
