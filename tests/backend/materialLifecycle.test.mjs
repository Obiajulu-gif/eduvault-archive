import { describe, it, expect, beforeEach } from 'vitest';
import { ObjectId } from 'mongodb';
import { MaterialLifecycleState, isValidTransition, transitionMaterialState } from '../../src/lib/db/materialLifecycle.js';

describe('Material Lifecycle State Machine', () => {
  describe('isValidTransition', () => {
    it('allows valid transitions', () => {
      // DRAFT
      expect(isValidTransition(MaterialLifecycleState.DRAFT, MaterialLifecycleState.ACTIVE)).toBe(true);
      
      // ACTIVE
      expect(isValidTransition(MaterialLifecycleState.ACTIVE, MaterialLifecycleState.PAUSED)).toBe(true);
      expect(isValidTransition(MaterialLifecycleState.ACTIVE, MaterialLifecycleState.ARCHIVED)).toBe(true);
      expect(isValidTransition(MaterialLifecycleState.ACTIVE, MaterialLifecycleState.SUSPENDED)).toBe(true);
      expect(isValidTransition(MaterialLifecycleState.ACTIVE, MaterialLifecycleState.RETIRED)).toBe(true);
      expect(isValidTransition(MaterialLifecycleState.ACTIVE, MaterialLifecycleState.REMOVED)).toBe(true);

      // PAUSED
      expect(isValidTransition(MaterialLifecycleState.PAUSED, MaterialLifecycleState.ACTIVE)).toBe(true);
      expect(isValidTransition(MaterialLifecycleState.PAUSED, MaterialLifecycleState.ARCHIVED)).toBe(true);
      expect(isValidTransition(MaterialLifecycleState.PAUSED, MaterialLifecycleState.SUSPENDED)).toBe(true);
      expect(isValidTransition(MaterialLifecycleState.PAUSED, MaterialLifecycleState.RETIRED)).toBe(true);
      expect(isValidTransition(MaterialLifecycleState.PAUSED, MaterialLifecycleState.REMOVED)).toBe(true);

      // ARCHIVED
      expect(isValidTransition(MaterialLifecycleState.ARCHIVED, MaterialLifecycleState.ACTIVE)).toBe(true);
      expect(isValidTransition(MaterialLifecycleState.ARCHIVED, MaterialLifecycleState.RETIRED)).toBe(true);
      expect(isValidTransition(MaterialLifecycleState.ARCHIVED, MaterialLifecycleState.SUSPENDED)).toBe(true);
      expect(isValidTransition(MaterialLifecycleState.ARCHIVED, MaterialLifecycleState.REMOVED)).toBe(true);

      // SUSPENDED
      expect(isValidTransition(MaterialLifecycleState.SUSPENDED, MaterialLifecycleState.ACTIVE)).toBe(true);
      expect(isValidTransition(MaterialLifecycleState.SUSPENDED, MaterialLifecycleState.REMOVED)).toBe(true);

      // RETIRED
      expect(isValidTransition(MaterialLifecycleState.RETIRED, MaterialLifecycleState.ACTIVE)).toBe(true);
      expect(isValidTransition(MaterialLifecycleState.RETIRED, MaterialLifecycleState.REMOVED)).toBe(true);
    });

    it('rejects invalid transitions', () => {
      // Reject DRAFT to anything but ACTIVE
      expect(isValidTransition(MaterialLifecycleState.DRAFT, MaterialLifecycleState.ARCHIVED)).toBe(false);
      expect(isValidTransition(MaterialLifecycleState.DRAFT, MaterialLifecycleState.SUSPENDED)).toBe(false);
      expect(isValidTransition(MaterialLifecycleState.DRAFT, MaterialLifecycleState.RETIRED)).toBe(false);
      expect(isValidTransition(MaterialLifecycleState.DRAFT, MaterialLifecycleState.REMOVED)).toBe(false);

      // Reject terminal state transitions
      expect(isValidTransition(MaterialLifecycleState.REMOVED, MaterialLifecycleState.ACTIVE)).toBe(false);
      expect(isValidTransition(MaterialLifecycleState.REMOVED, MaterialLifecycleState.ARCHIVED)).toBe(false);

      // Reject SUSPENDED to ARCHIVED (must be overturned first)
      expect(isValidTransition(MaterialLifecycleState.SUSPENDED, MaterialLifecycleState.ARCHIVED)).toBe(false);
      
      // Reject RETIRED to PAUSED (must be restored first)
      expect(isValidTransition(MaterialLifecycleState.RETIRED, MaterialLifecycleState.PAUSED)).toBe(false);
    });
  });

  describe('transitionMaterialState', () => {
    let mockDb;
    let mockCollection;
    let materialId;
    let mockAuditLog;

    beforeEach(() => {
      materialId = new ObjectId();
      mockCollection = {
        findOne: async ({ _id }) => {
          if (_id === materialId) return { _id: materialId, lifecycleState: MaterialLifecycleState.ACTIVE };
          return null;
        },
        updateOne: async () => ({ modifiedCount: 1 })
      };
      mockDb = {
        collection: () => mockCollection
      };
    });

    it('updates database and applies backwards-compatible flags', async () => {
      let updateOp;
      mockCollection.updateOne = async (filter, update) => {
        updateOp = update;
        return { modifiedCount: 1 };
      };

      await transitionMaterialState(mockDb, materialId, MaterialLifecycleState.RETIRED, { actor: 'admin' });
      
      expect(updateOp.$set.lifecycleState).toBe(MaterialLifecycleState.RETIRED);
      expect(updateOp.$set.isDeleted).toBe(true);
      expect(updateOp.$set.deletedBy).toBe('admin');
    });

    it('throws on invalid transition', async () => {
      mockCollection.findOne = async () => ({ _id: materialId, lifecycleState: MaterialLifecycleState.REMOVED });
      
      let error;
      try {
        await transitionMaterialState(mockDb, materialId, MaterialLifecycleState.ACTIVE);
      } catch (err) {
        error = err;
      }
      expect(error.message).toMatch(/Invalid lifecycle transition/);
    });
  });
});
