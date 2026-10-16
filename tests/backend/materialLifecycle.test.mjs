import test from 'node:test';
import assert from 'node:assert';
import { ObjectId } from 'mongodb';
import { MaterialLifecycleState, isValidTransition, transitionMaterialState } from '../../src/lib/db/materialLifecycle.js';

test('Material Lifecycle State Machine - isValidTransition', async (t) => {
  await t.test('allows valid transitions', () => {
    // DRAFT
    assert.strictEqual(isValidTransition(MaterialLifecycleState.DRAFT, MaterialLifecycleState.ACTIVE), true);
    
    // ACTIVE
    assert.strictEqual(isValidTransition(MaterialLifecycleState.ACTIVE, MaterialLifecycleState.PAUSED), true);
    assert.strictEqual(isValidTransition(MaterialLifecycleState.ACTIVE, MaterialLifecycleState.ARCHIVED), true);
    assert.strictEqual(isValidTransition(MaterialLifecycleState.ACTIVE, MaterialLifecycleState.SUSPENDED), true);
    assert.strictEqual(isValidTransition(MaterialLifecycleState.ACTIVE, MaterialLifecycleState.RETIRED), true);
    assert.strictEqual(isValidTransition(MaterialLifecycleState.ACTIVE, MaterialLifecycleState.REMOVED), true);

    // PAUSED
    assert.strictEqual(isValidTransition(MaterialLifecycleState.PAUSED, MaterialLifecycleState.ACTIVE), true);
    assert.strictEqual(isValidTransition(MaterialLifecycleState.PAUSED, MaterialLifecycleState.ARCHIVED), true);
    assert.strictEqual(isValidTransition(MaterialLifecycleState.PAUSED, MaterialLifecycleState.SUSPENDED), true);
    assert.strictEqual(isValidTransition(MaterialLifecycleState.PAUSED, MaterialLifecycleState.RETIRED), true);
    assert.strictEqual(isValidTransition(MaterialLifecycleState.PAUSED, MaterialLifecycleState.REMOVED), true);

    // ARCHIVED
    assert.strictEqual(isValidTransition(MaterialLifecycleState.ARCHIVED, MaterialLifecycleState.ACTIVE), true);
    assert.strictEqual(isValidTransition(MaterialLifecycleState.ARCHIVED, MaterialLifecycleState.RETIRED), true);
    assert.strictEqual(isValidTransition(MaterialLifecycleState.ARCHIVED, MaterialLifecycleState.SUSPENDED), true);
    assert.strictEqual(isValidTransition(MaterialLifecycleState.ARCHIVED, MaterialLifecycleState.REMOVED), true);

    // SUSPENDED
    assert.strictEqual(isValidTransition(MaterialLifecycleState.SUSPENDED, MaterialLifecycleState.ACTIVE), true);
    assert.strictEqual(isValidTransition(MaterialLifecycleState.SUSPENDED, MaterialLifecycleState.REMOVED), true);

    // RETIRED
    assert.strictEqual(isValidTransition(MaterialLifecycleState.RETIRED, MaterialLifecycleState.ACTIVE), true);
    assert.strictEqual(isValidTransition(MaterialLifecycleState.RETIRED, MaterialLifecycleState.REMOVED), true);
  });

  await t.test('rejects invalid transitions', () => {
    // Reject DRAFT to anything but ACTIVE
    assert.strictEqual(isValidTransition(MaterialLifecycleState.DRAFT, MaterialLifecycleState.ARCHIVED), false);
    assert.strictEqual(isValidTransition(MaterialLifecycleState.DRAFT, MaterialLifecycleState.SUSPENDED), false);
    assert.strictEqual(isValidTransition(MaterialLifecycleState.DRAFT, MaterialLifecycleState.RETIRED), false);
    assert.strictEqual(isValidTransition(MaterialLifecycleState.DRAFT, MaterialLifecycleState.REMOVED), false);

    // Reject terminal state transitions
    assert.strictEqual(isValidTransition(MaterialLifecycleState.REMOVED, MaterialLifecycleState.ACTIVE), false);
    assert.strictEqual(isValidTransition(MaterialLifecycleState.REMOVED, MaterialLifecycleState.ARCHIVED), false);

    // Reject SUSPENDED to ARCHIVED (must be overturned first)
    assert.strictEqual(isValidTransition(MaterialLifecycleState.SUSPENDED, MaterialLifecycleState.ARCHIVED), false);
    
    // Reject RETIRED to PAUSED (must be restored first)
    assert.strictEqual(isValidTransition(MaterialLifecycleState.RETIRED, MaterialLifecycleState.PAUSED), false);
  });
});

test('Material Lifecycle State Machine - transitionMaterialState', async (t) => {
  const materialId = new ObjectId();
  
  await t.test('updates database and applies backwards-compatible flags', async () => {
    let updateOp;
    const mockCollection = {
      findOne: async ({ _id }) => {
        if (String(_id) === String(materialId)) return { _id: materialId, lifecycleState: MaterialLifecycleState.ACTIVE };
        return null;
      },
      updateOne: async (filter, update) => {
        updateOp = update;
        return { modifiedCount: 1 };
      }
    };
    const mockDb = {
      collection: () => mockCollection
    };

    await transitionMaterialState(mockDb, materialId, MaterialLifecycleState.RETIRED, { actor: 'admin' });
    
    assert.strictEqual(updateOp.$set.lifecycleState, MaterialLifecycleState.RETIRED);
    assert.strictEqual(updateOp.$set.isDeleted, true);
    assert.strictEqual(updateOp.$set.deletedBy, 'admin');
  });

  await t.test('throws on invalid transition', async () => {
    const mockCollection = {
      findOne: async () => ({ _id: materialId, lifecycleState: MaterialLifecycleState.REMOVED }),
      updateOne: async () => ({ modifiedCount: 1 })
    };
    const mockDb = {
      collection: () => mockCollection
    };
    
    let error;
    try {
      await transitionMaterialState(mockDb, materialId, MaterialLifecycleState.ACTIVE);
    } catch (err) {
      error = err;
    }
    assert.ok(error, 'Expected an error to be thrown');
    assert.match(error.message, /Invalid lifecycle transition/);
  });
});
