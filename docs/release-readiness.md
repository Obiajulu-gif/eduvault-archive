# Release readiness gate

Issue #978. A release is blocked until its evidence file proves every gate
passed for the exact commit being released. The gate reads evidence only. It
doesn't run migrations, deploy, or change data.

## How it runs

- **Locally:** `npm run release:readiness` reads `release/readiness.json`.
  Use `-- --evidence <path>` and `-- --commit <sha>` to override the defaults.
- **In CI:** `.github/workflows/release-readiness.yml` runs on every `v*` tag
  push. It also runs on a PR that changes `release/readiness.json`. It passes
  `GITHUB_SHA`, so evidence for another commit is rejected.
- **Exit code:** `0` only when all gates pass. A missing file exits `1`.

Start from [`release/readiness.example.json`](../release/readiness.example.json).
Copy it to `release/readiness.json`, fill it in for the release commit, and commit it.

## Gates

| Gate | Passes when |
| ---- | ----------- |
| `evidence` | `release`, `commit`, and `generatedAt` are present. `commit` matches the release commit. `generatedAt` is within 14 days. |
| `migrations` | Every entry is `applied` (with `dryRunPassed` and `rollbackDocumented` both `true`) or `not_required`. `pending` blocks. `[]` means no migrations this release. A missing field blocks. |
| `security_checks` | `securityChecks.dependencyAudit` and `securityChecks.secretScan` are both `passed`. These match the `security.yml` jobs (`npm run audit:deps`, `npm run scan:secrets`). |
| `smoke_tests` | `smokeTests.status` is `passed` (for example, `npm run smoke:local` against the candidate). |
| `rollback_rehearsal` | `rollbackRehearsal.status` is `passed`, `restoredToCommit` names the known-good commit, and `rehearsedAt` is within 30 days. |

Every failing gate is reported in one run, so a maintainer sees the full list
at once.

## Edge cases and failure modes

- **Evidence was copied from an earlier release.** The commit check and the
  14-day window stop it. Regenerate the file.
- **Rehearsal is too old.** Re-run the restore into a staging environment and
  update `rehearsedAt`.
- **A migration was run in production but not dry-run first.** Record it as
  `applied` only with `dryRunPassed: true`, or the gate blocks. Real runs should
  always have a dry run.
- **Tag pushed before evidence was committed.** The tag workflow fails. Delete
  the tag, commit the evidence, and re-tag. Don't force-push over a published release.

## Rollback

The gate is read-only. Revert the commit that added the workflow or the script
to remove it. A release that already shipped isn't affected. The rollback
procedure itself is the one named in `rollbackRehearsal.restoredToCommit`.
