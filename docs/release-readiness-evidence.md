# Release readiness evidence

The release gate validates `release/readiness.json` for the commit being
released. Every migration must be applied or explicitly marked unnecessary.
Applied migrations require a successful dry run, documented rollback and a
verified rollback rehearsal. The gate also requires passing dependency and
secret checks, release-candidate smoke tests, and a recent successful rollback
rehearsal that names the restored known-good commit.

Run the same check locally with:

```bash
node scripts/release-readiness.mjs --evidence release/readiness.json --commit <commit-sha>
```

Missing or stale evidence blocks the release. Evidence mode is read-only and
does not execute migrations or mutate production data.

Code: `src/lib/release/readiness.js`. CLI: `scripts/release-readiness.mjs`.
Workflow: `.github/workflows/release-readiness.yml`. Tests:
`src/lib/__tests__/releaseEvidenceReadiness.test.js` (rules) and
`tests/backend/release-evidence-cli.test.mjs` (the CLI against a temporary git
repo). Template: `release/readiness.example.json`.

## Migration and recovery evidence (#1156)

Each entry in `migrations`:

| Field | Rule |
|-------|------|
| `id` | Required, non-empty, unique within the file. |
| `status` | `applied`, `not_required` or `pending`. `pending` blocks. |
| `dryRunPassed`, `rollbackDocumented` | `true` for `applied` migrations. |
| `rollbackVerification` | `"verified"` for `applied` migrations: the result of `npm run verify:rollback -- verify` after rehearsing the migration's rollback on staging (see [rollback-verification.md](rollback-verification.md)). `drift`, `unverifiable` or a missing value blocks. |

`rollbackRehearsal` (the application rollback): `status: "passed"`, a
`restoredToCommit` that is an earlier known-good commit and not the release
candidate itself, and a `rehearsedAt` within the last 30 days.

## Which commit the evidence must name

The evidence file is committed in the release, so it cannot contain the SHA of
the commit that contains it. Set `commit` to the release-candidate commit the
evidence was produced for, then commit the evidence on top of it and tag that
commit. The gate accepts the release when:

- the release commit is the evidenced commit, or
- `git diff --name-only <evidence.commit> <release commit>` lists only files
  under `release/`.

Any other changed file blocks the release with the list of files, because that
code was not covered by the evidence. The CLI computes the diff with git, so
the workflow checks out full history (`fetch-depth: 0`). Only hexadecimal SHAs
are passed to git. Any other `commit` value is treated as unknown and blocks.

The workflow checks the tagged commit on tag pushes. On pull requests it checks
the PR head (`github.event.pull_request.head.sha`). It does not use
`GITHUB_SHA`, which for `pull_request` is the synthetic merge commit.

## Paths covered by the tests

| Path | Cases |
|------|-------|
| Normal | Complete evidence for the release commit; a release commit that only adds evidence; identical trees. |
| Failure | Pending, unnamed, duplicate or unverified migrations; malformed migration lists; missing evidence. |
| Retry | A failed rehearsal blocks, and re-running the rehearsal and recording it passes. The gate is pure and read-only, so re-running it on the same input gives the same report. |
| Authorization | Evidence only authorizes the code it was produced for: evidence for another commit, or code changed after the evidence, blocks. |

## Edge cases

- **Future dates.** `generatedAt` or `rehearsedAt` more than 5 minutes in the
  future blocks. Such a date would otherwise never go stale.
- **Shallow clones.** If the evidenced commit is not in the local history, git
  cannot diff it. The gate blocks with "Evidence is for commit ..., but the
  release is ...". Fetch full history and re-run.
- **No migrations.** Use `"migrations": []`. A missing or non-array value blocks.

## Recovery and rollback

The gate never changes anything. To unblock a release:

1. Fix the cause: apply the migration, re-run the dry run, or rehearse the
   rollback and run `npm run verify:rollback -- verify` until it reports
   `verified`.
2. Regenerate `release/readiness.json` for the candidate commit with a current
   `generatedAt`.
3. Commit it (only under `release/`), and re-tag or re-run the workflow.

If a release already shipped and must be undone, follow
[incident-triage-runbook.md](incident-triage-runbook.md) and
[rollback-verification.md](rollback-verification.md).

## Migrating existing evidence files

The new rules apply to the next evidence file you produce. Past releases are not
re-checked, because the gate runs only on new tags and on PRs that change
`release/readiness.json`. To migrate a draft evidence file:

- add `"rollbackVerification": "verified"` to each applied migration after
  running the rollback verification;
- give every migration a unique `id`;
- point `commit` at the release candidate, not at the commit that will hold the
  evidence.
