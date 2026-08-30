import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import CreatorCard from "../CreatorCard";

describe("CreatorCard", () => {
  it("renders creator name, institution, and verified badge", () => {
    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 1);
    render(
      <CreatorCard
        author={{ name: "John Doe", institution: "MIT", level: "Advanced", credential: { status: "active", expiresAt: futureDate.toISOString() }, department: "Engineering" }}
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
    render(<CreatorCard author={{ name: "Jane" }} />);
    expect(screen.getByText("Creator profile unverified")).toBeInTheDocument();
  });
  
  it("shows unverified badge when credential expired", () => {
    const pastDate = new Date();
    pastDate.setFullYear(pastDate.getFullYear() - 1);
    render(<CreatorCard author={{ name: "Jane", credential: { status: "active", expiresAt: pastDate.toISOString() } }} />);
    expect(screen.getByText("Creator profile unverified")).toBeInTheDocument();
  });
  
  it("shows unverified badge when credential revoked", () => {
    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 1);
    render(<CreatorCard author={{ name: "Jane", credential: { status: "revoked", expiresAt: futureDate.toISOString() } }} />);
    expect(screen.getByText("Creator profile unverified")).toBeInTheDocument();
  });

  it("handles missing author gracefully", () => {
    render(<CreatorCard />);
    expect(screen.getByText("Anonymous creator")).toBeInTheDocument();
    expect(screen.getByText("Independent educator")).toBeInTheDocument();
  });
});
