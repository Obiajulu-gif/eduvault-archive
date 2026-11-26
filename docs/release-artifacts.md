# Reproducible Release Artifacts and Verification (#1104)

## Artifacts

Running the release artifact script produces `dist/release/`:

- `files/` - deterministic snapshot of selected source/docs/config inputs
- `SHA256SUMS` - SHA-256 checksums for all files in release snapshot
- `release-manifest.json` - file list, sizes, hashes, git/build metadata
- `sbom.cdx.json` - minimal CycloneDX SBOM from package dependencies
- `provenance.json` - source commit/ref and build command metadata

## Commands

```bash
node scripts/create-release-artifacts.mjs
node scripts/verify-release-artifacts.mjs dist/release
```

## Verification checks

`verify-release-artifacts` fails if:

- required artifact files are missing
- any checksum line is malformed
- any listed file is missing or hash-mismatched
- manifest hashes do not match actual files
- SBOM/provenance shape is invalid

## Normal / failure / retry / recovery

- **Normal**: create artifacts, verify, publish `dist/release`.
- **Failure**: verification exits non-zero with explicit mismatch/missing file.
- **Retry**: fix source/build issue, rerun create script, rerun verify.
- **Rollback**: keep previous verified `dist/release` tarball or git tag artifact set; do not promote unverified artifacts.

## Edge cases

- Dirty worktree: provenance includes git describe `--dirty`; release policy can reject dirty builds.
- Missing git metadata: script records nulls but verification still validates file integrity.
- Platform differences: checksums are over file contents in artifact snapshot; line endings should be committed consistently.
