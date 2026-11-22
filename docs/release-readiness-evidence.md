# Release Readiness Evidence

Release readiness evidence is machine-checked by `scripts/release-readiness.mjs`.

## Evidence mode

```bash
node scripts/release-readiness.mjs --evidence release/readiness.json --commit <sha>
```

The evidence file must include:

- `release`, `commit`, `generatedAt`
- `migrations[]`: each migration `applied` with `dryRunPassed` and `rollbackDocumented`, or explicitly `not_required`
- `securityChecks.dependencyAudit` and `securityChecks.secretScan` as `passed`
- `smokeTests.status` as `passed`
- `rollbackRehearsal.status` as `passed`, recent, with `restoredToCommit`

## Reproducible artifacts (#1104)

Before release, generate and verify artifacts:

```bash
npm run release:artifacts
npm run release:artifacts:verify
```

Attach `dist/release/SHA256SUMS`, `release-manifest.json`, `sbom.cdx.json`, and `provenance.json` to the release evidence/review.
