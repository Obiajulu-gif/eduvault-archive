# Resource Status Badges

Status badges appear on marketplace cards, the resource detail page, and the creator dashboard to give users an immediate read on a resource's availability and quality.

## Badge Reference

| Badge | Colour | Condition | Meaning |
|-------|--------|-----------|---------|
| **Free** | Green | `price` is `0` or absent | The resource costs nothing to access |
| **New** | Blue | `feedbackCount` is `0` **and** no rating recorded | No ratings yet — freshly published |
| **Top Rated** | Amber | `averageScore >= 4.5` (requires at least one review) | Community-verified high quality |
| **Verified** | Indigo | `material.author?.credential?.status === "active"` and not expired | Creator is actively verified with valid credential |
| **Popular** | Purple | `likes >= 1000` | Widely saved or liked by the community |
| **Draft** | Gray | `visibility === "private"` | Not published — only visible to the creator |
| **Unlisted** | Orange | `visibility === "unlisted"` | Accessible by direct link but not discoverable |
| **Published** | Green | `visibility === "public"` | Fully public and discoverable |
| **Unavailable** | Red | `syncStatus === "orphaned"` (chain reorg) **or** `creatorSuspended === true` | Access is temporarily blocked pending re-verification |
| **Restricted** | Red | `moderationStatus` is `suspended`, `removed`, or `rejected` | Access is restricted pending moderation review |
| **Stale** | Yellow | `updatedAt` is older than 24 hours | The other badges may not reflect the material's current state |

## Logic Rules

- **Free** and **New / Top Rated** are not mutually exclusive — a free resource can still be top rated.
- **New** is shown only when there are zero feedback entries *or* when the score is absent/zero.
- **Top Rated** replaces **New** once a qualifying score exists.
- **Draft**, **Unlisted**, and **Published** are mutually exclusive — only one visibility badge shows at a time.
- **Unavailable**, **Restricted**, and **Stale** (#676) are derived from fields the indexer (`lib/indexer/forkDetection.js`) and moderation pipeline already write onto the material document — `deriveBadges` never makes a network call itself. They only appear when the caller's query actually projected those fields onto the `material` object passed in; a caller whose query strips them simply won't show these badges, rather than erroring.
- Up to three badges are shown on cards (via `max={3}`); the detail page shows all.

## Component Usage

```jsx
import ResourceStatusBadge from "@/components/materials/ResourceStatusBadge";

// On a card — cap at 3 badges
<ResourceStatusBadge material={material} max={3} />

// On a detail page — show all badges
<ResourceStatusBadge material={material} />

// Render a single known badge
import { StatusBadge } from "@/components/materials/ResourceStatusBadge";
<StatusBadge label="Verified" />

// Derive badge labels programmatically
import { deriveBadges } from "@/components/materials/ResourceStatusBadge";
const badges = deriveBadges(material); // string[]
```

## Adding a New Badge

1. Add the badge label and Tailwind classes to `BADGE_STYLES` in [ResourceStatusBadge.jsx](../src/components/materials/ResourceStatusBadge.jsx).
2. Add the derivation rule to the `deriveBadges` function in the same file.
3. Update the table in this document.
