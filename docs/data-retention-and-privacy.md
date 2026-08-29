# Data Retention and Privacy Policy

This document defines EduVault's data retention, privacy boundaries, and learner data export rules (#708).

## Learner Progress & Bookmarks Privacy

1. **Owner-Only Access**: Learner progress records and bookmark notes are private to the learner (`walletAddress`).
2. **Access Control Enforcement**: API endpoints and internal modules enforce that `requestingActor` matches `walletAddress` before returning progress or export payloads.
3. **No Unsolicited Sharing**: Course creators and maintainers can view aggregate completion metrics, but individual learner bookmarks and custom notes are strictly restricted to the learner's own account.

## Data Retention and Versioning

1. **Version Scoping**: Progress and bookmarks are keyed by `(walletAddress, materialId, version)`.
2. **Immutability across Material Updates**: When creators publish new material versions or issue rollbacks:
   - Historical bookmarks attached to previous material versions are retained intact.
   - Updates never overwrite existing learner bookmark history.
3. **Data Export Rules**: Learners can request a full privacy data export (`exportLearnerProgress`) of all version-scoped progress records in standardized JSON format.
