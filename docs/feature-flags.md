# Feature Flags

Feature flags let maintainers stage rollout of risky behavior, compare behavior
between enabled/disabled cohorts, and disable a new path **without a redeploy**
— emergency rollback is an environment variable change, not a code change.

This document covers the flag system introduced in #797 and the flags currently
registered.

## How flags work

- Flags are defined in `src/lib/featureFlags.js` (`FEATURE_FLAG_REGISTRY`). Each
  entry carries a hard-coded **safe default** and a description.
- A flag `FOO` is read from the environment variable `FEATURE_FLAG_FOO`.
- **Missing or malformed configuration always falls back to the safe default.**
  A flag is never enabled by accident because a value was misspelled.
- Values `true` / `1` / `yes` / `on` (case-insensitive) enable a flag;
  `false` / `0` / `no` / `off` disable it. Anything else is treated as missing.
- Evaluation is synchronous and side-effect free, so flags are safe to call
  from both route handlers and React components.

## Registered flags

| Flag | Env var | Default | Controls |
| ---- | ------- | ------- | -------- |
| `CRITICAL_LIFECYCLE_NOTIFICATIONS` | `FEATURE_FLAG_CRITICAL_LIFECYCLE_NOTIFICATIONS` | `false` | In-app notifications for critical lifecycle/recovery events (purchases, refunds, entitlement changes, payouts, suspensions, wallet recovery). See [notifications](notifications.md). |
| `LEARNER_DATA_EXPORT` | `FEATURE_FLAG_LEARNER_DATA_EXPORT` | `false` | The authenticated learner data export endpoint `GET /api/learner-export`. See [data retention and privacy](data-retention-and-privacy.md). |

## Adding a flag

1. Add an entry to `FEATURE_FLAG_REGISTRY` in `src/lib/featureFlags.js` with a
   safe default and a description.
2. Read it with `isFeatureFlagEnabled('YOUR_FLAG')` at the call site.
3. Add the env var to `.env.example`.
4. Document the flag in this file.

## Rollout procedure

1. **Verify the default is safe.** With no env var set, the flag must evaluate to
   the safe behavior. Run `node scripts/feature-flag-status.mjs` to confirm.
2. **Enable in a preview environment.** Set the env var to `true` in a preview
   deployment and exercise the feature end-to-end.
3. **Enable in production.** Set the env var to `true` in the production
   environment. No redeploy is required — the value is read per process.
4. **Verify.** Re-run `node scripts/feature-flag-status.mjs` and confirm the
   flag reports `ENABLED` with `source: env var`.

## Verification

```bash
# Print every flag, its current value, and whether the value came from the
# environment or the safe default.
node scripts/feature-flag-status.mjs
```

The script exits `0` when all flags evaluate and `1` if the registry is
internally inconsistent.

## Emergency rollback

To disable a flagged behavior immediately:

1. Set the env var to `false` (or remove it) in the environment.
2. Restart the process (or wait for the next deploy) so the new value is read.

Because the safe default is always the disabled behavior, **removing the env var
is a complete rollback** — there is no state to clean up.

## Tests

`src/lib/__tests__/featureFlags.test.js` covers:

- every flag falls back to its safe default when config is missing
- explicit enabled and disabled values are both honored
- malformed values fall back to the safe default (never to enabled)
- truthy/falsy parsing is case-insensitive and ignores whitespace
- unknown flag keys throw
