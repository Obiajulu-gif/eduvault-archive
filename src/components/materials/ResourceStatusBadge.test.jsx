import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ResourceStatusBadge, { deriveBadges } from "./ResourceStatusBadge";

describe("deriveBadges — live availability/entitlement badges (#676)", () => {
  it("derives no live-state badge for an ordinary published material", () => {
    const badges = deriveBadges({ price: 10, visibility: "public", averageScore: 4, feedbackCount: 5 });
    expect(badges).not.toContain("Unavailable");
    expect(badges).not.toContain("Restricted");
    expect(badges).not.toContain("Stale");
  });

  it("derives Verified badge for material with valid creator credential", () => {
    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 1);
    const badges = deriveBadges({ author: { credential: { status: "active", expiresAt: futureDate.toISOString() } } });
    expect(badges).toContain("Verified");
  });

  it("does not derive Verified badge when creator credential is expired", () => {
    const pastDate = new Date();
    pastDate.setFullYear(pastDate.getFullYear() - 1);
    const badges = deriveBadges({ author: { credential: { status: "active", expiresAt: pastDate.toISOString() } } });
    expect(badges).not.toContain("Verified");
  });

  it("does not derive Verified badge when creator credential is revoked", () => {
    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 1);
    const badges = deriveBadges({ author: { credential: { status: "revoked", expiresAt: futureDate.toISOString() } } });
    expect(badges).not.toContain("Verified");
  });

  it("shows Unavailable when the indexer marked the material orphaned by a chain reorg", () => {
    const badges = deriveBadges({ price: 10, syncStatus: "orphaned" });
    expect(badges).toContain("Unavailable");
  });

  it("shows Unavailable when the creator is suspended", () => {
    const badges = deriveBadges({ price: 10, creatorSuspended: true });
    expect(badges).toContain("Unavailable");
  });

  it("does not show Unavailable for an unrelated syncStatus value", () => {
    const badges = deriveBadges({ price: 10, syncStatus: "synced" });
    expect(badges).not.toContain("Unavailable");
  });

  it.each(["suspended", "removed", "rejected"])(
    "shows Restricted when moderationStatus is %s",
    (moderationStatus) => {
      const badges = deriveBadges({ price: 10, moderationStatus });
      expect(badges).toContain("Restricted");
    }
  );

  it("does not show Restricted for a non-restricted moderation status", () => {
    const badges = deriveBadges({ price: 10, moderationStatus: "approved" });
    expect(badges).not.toContain("Restricted");
  });

  it("shows Stale when updatedAt is older than 24 hours", () => {
    const badges = deriveBadges({ price: 10, updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    expect(badges).toContain("Stale");
  });

  it("does not show Stale when updatedAt is recent", () => {
    const badges = deriveBadges({ price: 10, updatedAt: new Date(Date.now() - 60 * 1000) });
    expect(badges).not.toContain("Stale");
  });

  it("does not show Stale when updatedAt is absent", () => {
    const badges = deriveBadges({ price: 10 });
    expect(badges).not.toContain("Stale");
  });

  it("can show multiple live-state badges together", () => {
    const badges = deriveBadges({
      price: 10,
      syncStatus: "orphaned",
      moderationStatus: "suspended",
      updatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });
    expect(badges).toContain("Unavailable");
    expect(badges).toContain("Restricted");
    expect(badges).toContain("Stale");
  });

  it("returns an empty array for a null/undefined material", () => {
    expect(deriveBadges(null)).toEqual([]);
    expect(deriveBadges(undefined)).toEqual([]);
  });
});

describe("ResourceStatusBadge — rendering the live-state badges", () => {
  it("renders an Unavailable badge with an accessible label and tooltip", () => {
    render(<ResourceStatusBadge material={{ price: 10, syncStatus: "orphaned" }} />);
    const badge = screen.getByText("Unavailable");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute("aria-label", "Status: Unavailable");
    expect(badge).toHaveAttribute("title", "Temporarily unavailable — verifying on-chain state after a network event");
  });

  it("renders a Restricted badge", () => {
    render(<ResourceStatusBadge material={{ price: 10, moderationStatus: "removed" }} />);
    expect(screen.getByText("Restricted")).toBeInTheDocument();
  });

  it("renders a Stale badge", () => {
    render(
      <ResourceStatusBadge material={{ price: 10, updatedAt: new Date(Date.now() - 30 * 60 * 60 * 1000) }} />
    );
    expect(screen.getByText("Stale")).toBeInTheDocument();
  });

  it("renders nothing extra when no live-state condition applies", () => {
    render(<ResourceStatusBadge material={{ price: 10, visibility: "public", averageScore: 4, feedbackCount: 3 }} />);
    expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("Restricted")).not.toBeInTheDocument();
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();
  });
});
