import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkBalanceTransition,
  checkOwnershipTransition,
  checkEntitlementTransition,
  executeWithInvariantProtection,
} from '../../src/lib/transitions/invariantChecker.js';

/** Small, fast, seedable PRNG (mulberry32). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Simple cooperative scheduler for node:test */
function createScheduler({ prng }) {
  const queue = [];
  return {
    yield() {
      return new Promise((resolve) => queue.push(resolve));
    },
    async run(actors) {
      const results = [];
      const promises = actors.map(async (actor, idx) => {
        results[idx] = await actor();
      });

      while (queue.length > 0) {
        const nextIdx = Math.floor(prng() * queue.length);
        const [resume] = queue.splice(nextIdx, 1);
        resume();
        await new Promise((r) => setImmediate(r));
      }

      await Promise.all(promises);
      return results;
    },
  };
}

describe('Deterministic Replay Engine (#983)', () => {
  async function runSimulatedConcurrentScenario(seed) {
    const trace = [];
    const prng = mulberry32(seed);
    const scheduler = createScheduler({ prng });

    let sharedBalance = 1000;
    let entitlementState = 'NONE';
    let currentOwner = 'G_OWNER_1';

    const actorA = async () => {
      trace.push({ actor: 'A', step: 'start' });
      await scheduler.yield();

      const debitResult = checkBalanceTransition({
        fromBalance: sharedBalance,
        toBalance: sharedBalance - 150,
        delta: -150,
        currency: 'XLM',
        authorizedAccount: 'G_ACCOUNT',
        actor: 'G_ACCOUNT',
      });

      if (debitResult.valid) {
        sharedBalance -= 150;
        trace.push({ actor: 'A', step: 'debited', newBalance: sharedBalance });
      }

      await scheduler.yield();
      const entResult = checkEntitlementTransition({
        materialId: 'mat_123',
        buyerAddress: 'G_BUYER_A',
        fromStatus: entitlementState,
        toStatus: 'ACTIVE',
        purchaseId: 'tx_a_123',
      });

      if (entResult.valid) {
        entitlementState = 'ACTIVE';
        trace.push({ actor: 'A', step: 'entitled' });
      }

      return { balance: sharedBalance, entitlement: entitlementState };
    };

    const actorB = async () => {
      trace.push({ actor: 'B', step: 'start' });
      await scheduler.yield();

      // Competing transfer
      const debitResult = checkBalanceTransition({
        fromBalance: sharedBalance,
        toBalance: sharedBalance - 200,
        delta: -200,
        currency: 'XLM',
        authorizedAccount: 'G_ACCOUNT',
        actor: 'G_ACCOUNT',
      });

      if (debitResult.valid) {
        sharedBalance -= 200;
        trace.push({ actor: 'B', step: 'debited', newBalance: sharedBalance });
      }

      await scheduler.yield();
      // Competing ownership transfer
      const ownerCheck = checkOwnershipTransition({
        resourceId: 'res_123',
        currentOwner,
        proposedOwner: 'G_OWNER_B',
        actor: currentOwner,
        resourceStatus: 'ACTIVE',
      });

      if (ownerCheck.valid) {
        currentOwner = 'G_OWNER_B';
        trace.push({ actor: 'B', step: 'ownership_transferred' });
      }

      return { balance: sharedBalance, owner: currentOwner };
    };

    const actorC_Faulty = async () => {
      trace.push({ actor: 'C', step: 'start' });
      await scheduler.yield();

      try {
        await executeWithInvariantProtection({
          type: 'balance',
          transitionParams: {
            fromBalance: sharedBalance,
            toBalance: sharedBalance - 50,
            delta: -50,
            currency: 'XLM',
            authorizedAccount: 'G_ACCOUNT',
            actor: 'G_ACCOUNT',
          },
          executeFn: async () => {
            trace.push({ actor: 'C', step: 'executing_mutation' });
            throw new Error('NETWORK_TIMEOUT_TRIGGERING_ROLLBACK');
          },
        });
      } catch (err) {
        trace.push({ actor: 'C', step: 'rolled_back', rollback: err.rollbackState });
      }

      return { success: false };
    };

    const results = await scheduler.run([actorA, actorB, actorC_Faulty]);
    return {
      trace,
      results,
      finalState: { sharedBalance, entitlementState, currentOwner },
    };
  }

  it('produces bit-for-bit identical execution traces and states across duplicate replays', async () => {
    const seeds = [42, 100, 777, 9999];

    for (const seed of seeds) {
      const run1 = await runSimulatedConcurrentScenario(seed);
      const run2 = await runSimulatedConcurrentScenario(seed);

      assert.deepEqual(run1.trace, run2.trace);
      assert.deepEqual(run1.results, run2.results);
      assert.deepEqual(run1.finalState, run2.finalState);
    }
  });

  it('preserves invariants under all interleaved retry orders', async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const run = await runSimulatedConcurrentScenario(seed);
      // Balance conservation invariant
      assert.ok(run.finalState.sharedBalance >= 0);
      assert.equal(run.finalState.sharedBalance, 650); // 1000 - 150 - 200
      assert.equal(run.finalState.entitlementState, 'ACTIVE');
      assert.equal(run.finalState.currentOwner, 'G_OWNER_B');
    }
  });
});
