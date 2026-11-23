# Deterministic Recovery Tests for Interrupted Workflows (#1071)

## Overview
`test/concurrency/interruptedWorkflowRecovery.test.js` verifies that interrupted multi-step workflows recover deterministically across identical PRNG seeds (`mulberry32`) without duplicate side-effects, lost checkpoints, or authorization bypasses.

## Covered Paths
- **Normal & Interrupted Batch Recovery**: Mid-flight transient errors invoke `onRollback`, pause at the last durable checkpoint, and resume to completion with bit-for-bit identical traces across runs.
- **Exhausted Attempts -> Dead-Letter -> Authorized Recovery**: Exhausted workflows enter `dead_letter`, reject unauthorized recovery (`401`/`403`), and resume from their saved checkpoint once recovered by an authorized operator.
- **Interrupted Permission-Aware Exports**: Transient fetch interruptions retry deterministically and yield identical SHA-256 `contentHash` digests; unauthorized callers fail fast before any fetch.

## Compatibility
All tests run against existing public module contracts (`resumableJob.js`, `permissionAwareExport.js`, `harness.js`) without modifying existing test suites.
