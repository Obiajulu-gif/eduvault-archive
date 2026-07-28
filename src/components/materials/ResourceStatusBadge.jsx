/**
 * ResourceStatusBadge — derives and renders status badges for a material.
 *
 * Badge meanings:
 *   Free        — price is 0 or absent
 *   New         — no feedback/ratings recorded yet
 *   Verified    — creator-verified content (material.verified === true)
 *   Top Rated   — averageScore >= 4.5
 *   Popular     — likes >= 1000
 *   Draft       — visibility is "private"
 *   Unlisted    — visibility is "unlisted"
 *   Published   — visibility is "public"
 *
 * See docs/resource-status-badges.md for full reference.
 */

const BADGE_STYLES = {
  Free: "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800",
  New: "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800",
  Verified: "bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800",
  "Top Rated": "bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800",
  Popular: "bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800",
  Draft: "bg-gray-100 dark:bg-surface-muted text-gray-600 dark:text-muted-foreground border border-gray-200 dark:border-border-strong",
  Unlisted: "bg-orange-50 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 border border-orange-200 dark:border-orange-800",
  Published: "bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800",
};

const BADGE_TOOLTIPS = {
  Free: "No cost — freely available to all learners",
  New: "Recently listed with no ratings yet",
  Verified: "Content reviewed and verified by the creator",
  "Top Rated": "Average score of 4.5 or higher",
  Popular: "Over 1,000 learner likes",
  Draft: "Private draft — not publicly listed",
  Unlisted: "Accessible by link only",
  Published: "Publicly listed in the marketplace",
};

export function deriveBadges(material) {
  if (!material) return [];

  const badges = [];
  const price = Number(material.price ?? 0);
  const score = Number(material.averageScore ?? material.rating ?? 0);
  const feedbackCount = Number(material.feedbackCount ?? material.reviewsCount ?? 0);
  const likes = Number(material.likes ?? 0);
  const visibility = material.visibility;

  if (!Number.isFinite(price) || price === 0) {
    badges.push("Free");
  }

  if (feedbackCount === 0 || !Number.isFinite(score) || score === 0) {
    badges.push("New");
  } else if (score >= 4.5) {
    badges.push("Top Rated");
  }

  if (material.verified) {
    badges.push("Verified");
  }

  if (likes >= 1000) {
    badges.push("Popular");
  }

  if (visibility === "private") {
    badges.push("Draft");
  } else if (visibility === "unlisted") {
    badges.push("Unlisted");
  } else if (visibility === "public") {
    badges.push("Published");
  }

  return badges;
}

/**
 * Renders a single badge pill with an optional tooltip.
 */
export function StatusBadge({ label, className = "" }) {
  const base = BADGE_STYLES[label] ?? "bg-gray-100 dark:bg-surface-muted text-gray-600 dark:text-muted-foreground border border-gray-200 dark:border-border-strong";
  const tooltip = BADGE_TOOLTIPS[label];
  return (
    <span
      className={`relative inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold leading-tight cursor-default ${base} ${className}`}
      aria-label={`Status: ${label}`}
      title={tooltip}
    >
      {label}
    </span>
  );
}

/**
 * Creator info badge — shows the creator label with a tooltip.
 */
export function CreatorBadge({ creator, className = "" }) {
  if (!creator) return null;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold leading-tight bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 cursor-default ${className}`}
      title={`Created by ${creator}`}
      aria-label={`Creator: ${creator}`}
    >
      by {creator}
    </span>
  );
}

/**
 * Update date badge — shows when the resource was last updated.
 */
export function UpdatedAtBadge({ date, className = "" }) {
  if (!date) return null;
  const formatted = new Date(date).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold leading-tight bg-gray-50 dark:bg-surface-muted text-gray-500 dark:text-muted-foreground border border-gray-200 dark:border-border-strong cursor-default ${className}`}
      title={`Last updated: ${formatted}`}
      aria-label={`Last updated: ${formatted}`}
    >
      Updated {formatted}
    </span>
  );
}

/**
 * Renders a row of status badges derived from a material object.
 * Also shows creator label and last-updated date when present.
 *
 * @param {object}  material  - material data object
 * @param {number}  [max]     - max status badges to show (default: all)
 * @param {boolean} [showCreator]   - show creator badge (default: false)
 * @param {boolean} [showUpdatedAt] - show updated date badge (default: false)
 * @param {string}  [className]
 */
export default function ResourceStatusBadge({
  material,
  max,
  showCreator = false,
  showUpdatedAt = false,
  className = "",
}) {
  const badges = deriveBadges(material);
  const visible = max ? badges.slice(0, max) : badges;
  const creator = material?.author || material?.creatorName || null;
  const updatedAt = material?.updatedAt || material?.createdAt || null;

  const hasContent = visible.length > 0 || (showCreator && creator) || (showUpdatedAt && updatedAt);
  if (!hasContent) return null;

  return (
    <div
      className={`flex flex-wrap gap-1 ${className}`}
      role="list"
      aria-label="Resource info badges"
    >
      {visible.map((label) => (
        <span key={label} role="listitem">
          <StatusBadge label={label} />
        </span>
      ))}
      {showCreator && creator && (
        <span role="listitem">
          <CreatorBadge creator={creator} />
        </span>
      )}
      {showUpdatedAt && updatedAt && (
        <span role="listitem">
          <UpdatedAtBadge date={updatedAt} />
        </span>
      )}
    </div>
  );
}
