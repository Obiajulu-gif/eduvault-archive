import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import MaterialNotFound from "../MaterialNotFound";

describe("MaterialNotFound", () => {
  it("renders the not-found heading and explanation", () => {
    render(<MaterialNotFound />);
    expect(screen.getByRole("heading", { name: "Material not found" })).toBeInTheDocument();
    expect(
      screen.getByText(/removed, made private, or the link is incorrect/i),
    ).toBeInTheDocument();
  });

  it("links back to the marketplace instead of offering a retry", () => {
    render(<MaterialNotFound />);
    expect(screen.getByRole("link", { name: "Browse the marketplace" })).toHaveAttribute(
      "href",
      "/marketplace",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
