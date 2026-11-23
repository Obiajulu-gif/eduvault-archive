/**
 * Automated Verification: Deterministic Conflict Resolver for Multi-Client Edits
 *
 * Covers Acceptance Criteria:
 *   1. Normal Path: Orthogonal multi-client edits, idempotent identical edits, array tag unions, numeric deltas, and atomic resolution.
 *   2. Failure Path: Critical field conflicts in strict mode, tombstone/deletion resurrection prevention, and conflict envelopes.
 *   3. Retry Path: Conflict payload inspection, client preference application, and successful CAS retry.
 *   4. Authorization Path: Role-based field editing authorization, creator tenant isolation, and privilege escalation prevention.
 */

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';

import {
  CONFLICT_STATUS,
  diffDocuments,
  valuesAreEqual,
  resolveConflictThreeWay,
  validateFieldAuthorization,
  buildConflictAuditRecord,
  updateWithConflictResolution,
} from '../../src/lib/backend/conflictResolver.js';

// In-memory mock collection for concurrency tests
function createMockCollection(initialDocs = []) {
  const docs = JSON.parse(JSON.stringify(initialDocs));

  return {
    async findOne(filter) {
      return docs.find((d) => {
        if (filter._id && String(d._id) !== String(filter._id)) return false;
        if (filter.version !== undefined && d.version !== filter.version) return false;
        return true;
      }) ? JSON.parse(JSON.stringify(docs.find((d) => String(d._id) === String(filter._id)))) : null;
    },

    async findOneAndUpdate(filter, update, options = {}) {
      const idx = docs.findIndex((d) => {
        if (filter._id && String(d._id) !== String(filter._id)) return false;
        if (filter.version !== undefined && d.version !== filter.version) return false;
        if (filter.$or) {
          const matchOr = filter.$or.some((clause) => {
            if (clause.version !== undefined && d.version === clause.version) return true;
            if (clause.version?.$exists === false && (d.version === undefined || d.version === null)) return true;
            return false;
          });
          if (!matchOr) return false;
        }
        return true;
      });

      if (idx === -1) return null;

      const before = JSON.parse(JSON.stringify(docs[idx]));
      if (update.$set) {
        docs[idx] = { ...docs[idx], ...update.$set };
      }
      const after = JSON.parse(JSON.stringify(docs[idx]));
      return options.returnDocument === 'after' ? after : before;
    },

    _getAll() {
      return docs;
    },
  };
}

describe('Deterministic Conflict Resolver for Multi-Client Edits', () => {
  let baseMaterial;

  beforeEach(() => {
    baseMaterial = {
      _id: 'mat-comp-101',
      title: 'Introductory Mechanics',
      description: 'First edition lecture notes covering Newton laws and kinematics.',
      subject: 'physics',
      price: 15.0,
      tags: ['physics', 'mechanics', 'newton'],
      likes: 20,
      visibility: 'public',
      license: 'Standard License (download only)',
      author: 'creator-alice',
      userAddress: 'creator-alice',
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      isDeleted: false,
    };
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 1. NORMAL PATH: Orthogonal Merges, Sets, Deltas & Atomic Convergence
  // ══════════════════════════════════════════════════════════════════════════════
  describe('Normal Path — 3-Way Auto-Merge, Set Unions, Deltas & Concurrency', () => {
    test('orthogonal edits: client A updates title while client B updates price and description', () => {
      // Base: V1
      const base = { ...baseMaterial };

      // Server already committed Client B's edits: V2
      const server = {
        ...base,
        description: 'Second edition notes with added thermodynamics problem sets.',
        price: 22.5,
        version: 2,
        updatedAt: '2026-06-01T10:00:00.000Z',
      };

      // Client A's concurrent edits based on V1
      const client = {
        ...base,
        title: 'Classical & Modern Mechanics',
      };

      const result = resolveConflictThreeWay({
        base,
        server,
        client,
      });

      assert.equal(result.canAutoMerge, true);
      assert.equal(result.status, CONFLICT_STATUS.AUTO_MERGED);
      assert.equal(result.newVersion, 3);

      // Verify merged outcome contains BOTH client A and client B updates
      assert.equal(result.mergedDocument.title, 'Classical & Modern Mechanics');
      assert.equal(result.mergedDocument.description, 'Second edition notes with added thermodynamics problem sets.');
      assert.equal(result.mergedDocument.price, 22.5);
      assert.equal(result.unresolvedConflicts.length, 0);
    });

    test('idempotent identical edits: both clients change visibility to private converges cleanly', () => {
      const base = { ...baseMaterial };
      const server = { ...base, visibility: 'private', version: 2 };
      const client = { ...base, visibility: 'private' };

      const result = resolveConflictThreeWay({ base, server, client });

      assert.equal(result.canAutoMerge, true);
      assert.equal(result.mergedDocument.visibility, 'private');
      assert.equal(result.resolvedFields.visibility.strategy, 'idempotent_identical');
    });

    test('array set union: merges tags concurrently added by distinct clients without duplicates', () => {
      const base = { ...baseMaterial, tags: ['physics', 'mechanics'] };
      // Server added 'energy' and 'momentum'
      const server = { ...base, tags: ['physics', 'mechanics', 'energy', 'momentum'], version: 2 };
      // Client added 'energy' (overlapping) and 'kinematics' (unique)
      const client = { ...base, tags: ['physics', 'mechanics', 'energy', 'kinematics'] };

      const result = resolveConflictThreeWay({ base, server, client });

      assert.equal(result.canAutoMerge, true);
      assert.equal(result.resolvedFields.tags.strategy, 'array_set_union');

      // Merged must contain all 5 unique tags
      const mergedTags = result.mergedDocument.tags;
      assert.equal(mergedTags.length, 5);
      assert.ok(mergedTags.includes('physics'));
      assert.ok(mergedTags.includes('mechanics'));
      assert.ok(mergedTags.includes('energy'));
      assert.ok(mergedTags.includes('momentum'));
      assert.ok(mergedTags.includes('kinematics'));
    });

    test('numeric counter delta: merges concurrent likes counters accurately', () => {
      const base = { ...baseMaterial, likes: 100 };
      // Server added +5 likes -> 105
      const server = { ...base, likes: 105, version: 2 };
      // Client added +8 likes -> 108
      const client = { ...base, likes: 108 };

      const result = resolveConflictThreeWay({ base, server, client });

      assert.equal(result.canAutoMerge, true);
      assert.equal(result.resolvedFields.likes.strategy, 'numeric_relative_delta');
      // 105 + (108 - 100) = 113
      assert.equal(result.mergedDocument.likes, 113);
    });

    test('deterministic tie-breaker: equal timestamps break ties using actor ID lexicographical order', () => {
      const base = { ...baseMaterial, shortSummary: 'Original summary' };
      const timestamp = 1750000000000;

      // Server modified by 'actor-bob' at timestamp
      const server = { ...base, shortSummary: 'Bob summary', version: 2 };
      // Client modified by 'actor-charlie' at same timestamp
      const client = { ...base, shortSummary: 'Charlie summary' };

      const result = resolveConflictThreeWay({
        base,
        server,
        client,
        serverMeta: { actor: 'actor-bob', timestamp },
        clientMeta: { actor: 'actor-charlie', timestamp },
      });

      assert.equal(result.canAutoMerge, true);
      // 'actor-charlie' > 'actor-bob' -> client wins tie
      assert.equal(result.mergedDocument.shortSummary, 'Charlie summary');
      assert.equal(result.resolvedFields.shortSummary.strategy, 'lww_actor_tiebreak');
    });

    test('updateWithConflictResolution: automatically resolves racing writes and commits to collection', async () => {
      const collection = createMockCollection([baseMaterial]);

      // Simulate Client A winning the write first
      await collection.findOneAndUpdate(
        { _id: 'mat-comp-101', version: 1 },
        { $set: { title: 'Mechanics (Client A Winner)', version: 2 } }
      );

      // Now Client B submits update computed against version 1
      const clientDoc = {
        ...baseMaterial,
        price: 35.0, // Client B only changed price
      };

      const outcome = await updateWithConflictResolution(collection, {
        id: 'mat-comp-101',
        baseVersion: 1, // Stale!
        clientDoc,
        actor: { id: 'creator-alice', role: 'creator' },
        baseDoc: baseMaterial,
      });

      assert.equal(outcome.status, CONFLICT_STATUS.AUTO_MERGED);
      assert.equal(outcome.doc.version, 3);
      assert.equal(outcome.doc.title, 'Mechanics (Client A Winner)');
      assert.equal(outcome.doc.price, 35.0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 2. FAILURE PATH: Critical Conflicts, Deletion Tombstones & Error Envelopes
  // ══════════════════════════════════════════════════════════════════════════════
  describe('Failure Path — Critical Conflicts, Strict Mode & Tombstones', () => {
    test('conflicting critical fields in strict mode requires manual resolution', () => {
      const base = { ...baseMaterial, license: 'Standard License (download only)' };
      const server = { ...base, license: 'Creative Commons', version: 2 };
      const client = { ...base, license: 'Private Use Only' };

      const result = resolveConflictThreeWay({
        base,
        server,
        client,
        strict: true, // Strict mode enabled
      });

      assert.equal(result.canAutoMerge, false);
      assert.equal(result.status, CONFLICT_STATUS.CONFLICT_REQUIRES_ACTION);
      assert.equal(result.unresolvedConflicts.length, 1);
      assert.equal(result.unresolvedConflicts[0].field, 'license');
      assert.equal(result.unresolvedConflicts[0].serverValue, 'Creative Commons');
      assert.equal(result.unresolvedConflicts[0].clientValue, 'Private Use Only');
    });

    test('tombstoned/deleted document rejects resurrection edit', () => {
      const base = { ...baseMaterial, isDeleted: false };
      // Server already soft-deleted this record
      const server = { ...base, isDeleted: true, version: 2 };
      // Stale client tries to update title
      const client = { ...base, title: 'Resurrected Title' };

      const result = resolveConflictThreeWay({ base, server, client });

      assert.equal(result.canAutoMerge, false);
      assert.equal(result.status, CONFLICT_STATUS.INVALID_TRANSITION);
      assert.ok(result.error.includes('deleted or tombstoned'));
    });

    test('returns NOT_FOUND when updating non-existent material', async () => {
      const collection = createMockCollection([]);

      const outcome = await updateWithConflictResolution(collection, {
        id: 'non-existent-id',
        baseVersion: 1,
        clientDoc: { title: 'New' },
      });

      assert.equal(outcome.status, CONFLICT_STATUS.NOT_FOUND);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 3. RETRY PATH: Conflict Diff Descriptors & Manual Preference Application
  // ══════════════════════════════════════════════════════════════════════════════
  describe('Retry Path — Conflict Diff Inspection & Resubmission Recovery', () => {
    test('unresolved conflict returns complete diff payload allowing client to retry with preference', async () => {
      const collection = createMockCollection([
        { ...baseMaterial, license: 'Creative Commons', version: 2 },
      ]);

      // Client submits with conflicting license under strict mode
      const clientEdit = {
        ...baseMaterial,
        license: 'Private Use Only',
      };

      const conflictOutcome = await updateWithConflictResolution(collection, {
        id: 'mat-comp-101',
        baseVersion: 1,
        clientDoc: clientEdit,
        actor: { id: 'creator-alice', role: 'creator' },
        baseDoc: baseMaterial,
        strict: true,
      });

      // 1. Client receives 409 conflict payload with retry details
      assert.equal(conflictOutcome.status, CONFLICT_STATUS.CONFLICT_REQUIRES_ACTION);
      assert.equal(conflictOutcome.retryable, true);
      assert.equal(conflictOutcome.currentVersion, 2);
      assert.ok(conflictOutcome.diff);
      assert.equal(conflictOutcome.diff.server.license, 'Creative Commons');
      assert.equal(conflictOutcome.diff.client.license, 'Private Use Only');

      // 2. Client chooses resolution strategy: accepts server license, updates description
      const resolvedClientSubmission = {
        ...conflictOutcome.diff.server,
        description: 'Updated description after reviewing server license.',
      };

      // 3. Client retries CAS with expectedVersion = 2
      const retryOutcome = await updateWithConflictResolution(collection, {
        id: 'mat-comp-101',
        baseVersion: 2, // Updated to latest!
        clientDoc: resolvedClientSubmission,
        actor: { id: 'creator-alice', role: 'creator' },
        baseDoc: conflictOutcome.diff.server,
      });

      assert.equal(retryOutcome.status, CONFLICT_STATUS.CLEAN_WRITE);
      assert.equal(retryOutcome.doc.version, 3);
      assert.equal(retryOutcome.doc.license, 'Creative Commons');
      assert.equal(retryOutcome.doc.description, 'Updated description after reviewing server license.');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 4. AUTHORIZATION PATH: Role Scoping, Tenant Isolation & Privilege Escalation
  // ══════════════════════════════════════════════════════════════════════════════
  describe('Authorization Path — Role Enforcement, Tenant Isolation & Privileged Fields', () => {
    test('learner role is completely blocked from modifying materials', async () => {
      const collection = createMockCollection([baseMaterial]);

      const outcome = await updateWithConflictResolution(collection, {
        id: 'mat-comp-101',
        baseVersion: 1,
        clientDoc: { ...baseMaterial, title: 'Learner Hack' },
        actor: { id: 'learner-bob', role: 'learner' },
      });

      assert.equal(outcome.status, CONFLICT_STATUS.UNAUTHORIZED);
      assert.ok(outcome.error.includes('Learner role is not authorized'));
    });

    test('creator cannot modify materials belonging to another creator (cross-tenant isolation)', async () => {
      const collection = createMockCollection([baseMaterial]); // Owned by creator-alice

      const outcome = await updateWithConflictResolution(collection, {
        id: 'mat-comp-101',
        baseVersion: 1,
        clientDoc: { ...baseMaterial, title: 'Mallory update' },
        actor: { id: 'creator-mallory', role: 'creator' }, // Different creator!
      });

      assert.equal(outcome.status, CONFLICT_STATUS.UNAUTHORIZED);
      assert.ok(outcome.error.includes('owned by another creator'));
    });

    test('creator cannot smuggle privileged fields into a conflict merge', async () => {
      const collection = createMockCollection([baseMaterial]);

      const outcome = await updateWithConflictResolution(collection, {
        id: 'mat-comp-101',
        baseVersion: 1,
        clientDoc: {
          ...baseMaterial,
          title: 'Legitimate Title Edit',
          moderationStatus: 'approved', // Privileged!
          quarantineStatus: 'clean',    // Privileged!
        },
        actor: { id: 'creator-alice', role: 'creator' },
      });

      assert.equal(outcome.status, CONFLICT_STATUS.UNAUTHORIZED);
      assert.ok(outcome.error.includes('cannot modify privileged fields'));
      assert.ok(outcome.unauthorizedFields.includes('moderationStatus'));
      assert.ok(outcome.unauthorizedFields.includes('quarantineStatus'));
    });

    test('administrator is permitted to modify privileged fields across materials', async () => {
      const collection = createMockCollection([baseMaterial]);

      const outcome = await updateWithConflictResolution(collection, {
        id: 'mat-comp-101',
        baseVersion: 1,
        clientDoc: {
          ...baseMaterial,
          moderationStatus: 'approved',
          internalReviewFlags: { audited: true },
        },
        actor: { id: 'admin-super', role: 'admin' },
      });

      assert.equal(outcome.status, CONFLICT_STATUS.CLEAN_WRITE);
      assert.equal(outcome.doc.moderationStatus, 'approved');
      assert.equal(outcome.doc.version, 2);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 5. AUDIT / JOURNAL INTEGRATION
  // ══════════════════════════════════════════════════════════════════════════════
  describe('Audit Logging & Conflict Journaling', () => {
    test('buildConflictAuditRecord produces reproducible audit entry', () => {
      const audit = buildConflictAuditRecord({
        materialId: 'mat-101',
        actor: 'creator-alice',
        baseVersion: 1,
        serverVersion: 2,
        newVersion: 3,
        status: CONFLICT_STATUS.AUTO_MERGED,
        resolvedFields: {
          tags: { strategy: 'array_set_union', winner: 'union' },
          likes: { strategy: 'numeric_relative_delta', winner: 'delta' },
        },
      });

      assert.equal(audit.materialId, 'mat-101');
      assert.equal(audit.status, CONFLICT_STATUS.AUTO_MERGED);
      assert.equal(audit.resolvedFields.length, 2);
      assert.equal(audit.unresolvedCount, 0);
      assert.ok(audit.timestamp);
    });
  });
});
