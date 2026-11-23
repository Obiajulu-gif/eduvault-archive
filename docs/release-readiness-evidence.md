# Release readiness evidence

The release gate validates `release/readiness.json` for the exact commit being
released. Every migration must be applied or explicitly marked unnecessary;
applied migrations require a successful dry run and documented rollback. The
gate also requires passing dependency and secret checks, release-candidate
smoke tests, and a recent successful rollback rehearsal naming the restored
known-good commit.

Run the same check locally with:

```bash
node scripts/release-readiness.mjs --evidence release/readiness.json --commit <commit-sha>
```

Missing or stale evidence blocks the release. Evidence mode is read-only and
does not execute migrations or mutate production data.
