/**
 * Multi-actor concurrency harness.
 *
 * Real races depend on timing, which makes them flaky to test. This harness
 * makes them deterministic: every database operation is a *scheduling point*,
 * and a seeded scheduler decides which waiting actor runs next. The same seed
 * always replays the same interleaving; sweeping many seeds explores many
 * different interleavings of the same scenario.
 *
 * Model
 * - Each document operation is atomic (like a single-document MongoDB write):
 *   the operation's effect happens synchronously between two yield points.
 * - Actors are plain async functions. They interleave only at DB calls (via
 *   `instrumentDb`) or explicit `scheduler.yield()` calls.
 * - On failure the thrown error is prefixed with `[seed=N]`; re-run just that
 *   seed (`explore({ seeds: [N] })`) to reproduce it exactly.
 *
 * Usage
 *   await explore({ seeds: 40, scenario: async ({ scheduler, seed }) => {
 *     const db = instrumentDb(createFakeDb({ things: createFakeCollection() }), scheduler);
 *     const results = await scheduler.run([actorA(db), actorB(db)]);
 *     // assert invariants that must hold for EVERY interleaving
 *   }});
 */

/** Small, fast, seedable PRNG (mulberry32). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const macrotask = typeof setImmediate === "function" ? setImmediate : (fn) => setTimeout(fn, 0);

/**
 * Seeded cooperative scheduler. Actors park on `yield()`; once every runnable
 * actor is parked (microtask queue drained) one is released at random.
 */
export function createScheduler({ seed = 1, maxSteps = 100_000 } = {}) {
  const random = mulberry32(seed);
  const waiting = [];
  const trace = [];
  let pumping = false;
  let steps = 0;

  function pump() {
    if (pumping || waiting.length === 0) return;
    pumping = true;
    macrotask(() => {
      pumping = false;
      if (waiting.length === 0) return;
      if (++steps > maxSteps) {
        // Release everything so the scenario fails loudly instead of hanging.
        for (const entry of waiting.splice(0)) entry.reject(new Error(`scheduler exceeded ${maxSteps} steps`));
        return;
      }
      const index = Math.floor(random() * waiting.length);
      const [entry] = waiting.splice(index, 1);
      trace.push(entry.label);
      entry.resolve();
      pump();
    });
  }

  return {
    seed,
    trace,
    /** Park the calling actor until the scheduler chooses to resume it. */
    yield(label = "yield") {
      return new Promise((resolve, reject) => {
        waiting.push({ label, resolve, reject });
        pump();
      });
    },
    /**
     * Start all actors "at once" and wait for every one to settle.
     * Actors may be functions (called with the scheduler) or promises-returning
     * thunks; each starts parked so the first step is also scheduler-chosen.
     */
    async run(actors) {
      const started = actors.map(async (actor, index) => {
        await this.yield(`start:${index}`);
        return typeof actor === "function" ? actor(this, index) : actor;
      });
      return Promise.allSettled(started);
    },
  };
}

const ASYNC_OPS = ["findOne", "insertOne", "updateOne", "findOneAndUpdate", "deleteOne", "replaceOne", "countDocuments"];

/**
 * Wrap a db so every awaited collection operation is a scheduling point
 * *before* it executes. The operation itself stays atomic.
 */
export function instrumentDb(db, scheduler) {
  return {
    collection(name) {
      const collection = db.collection(name);
      if (!collection) return collection; // unknown collection: let callers feature-detect
      return new Proxy(collection, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value === "function" && ASYNC_OPS.includes(prop)) {
            return async (...args) => {
              await scheduler.yield(`${name}.${prop}`);
              return value.apply(target, args);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
}

/**
 * Run `scenario` once per seed. Every run gets a fresh scheduler. Failures are
 * re-thrown with the seed so they can be replayed deterministically.
 *
 * @returns {Promise<{runs: number, distinctInterleavings: number}>}
 */
export async function explore({ seeds = 25, scenario }) {
  const seedList = Array.isArray(seeds) ? seeds : Array.from({ length: seeds }, (_, i) => i + 1);
  const interleavings = new Set();

  for (const seed of seedList) {
    const scheduler = createScheduler({ seed });
    try {
      await scenario({ scheduler, seed });
    } catch (error) {
      error.message = `[seed=${seed}] ${error.message}`;
      throw error;
    } finally {
      interleavings.add(scheduler.trace.join("|"));
    }
  }
  return { runs: seedList.length, distinctInterleavings: interleavings.size };
}

/**
 * A retry storm: `clients` actors each retry `attempt` until it stops
 * throwing a retryable error (or `maxAttempts` is reached), yielding between
 * attempts like a client backing off. Returns per-client outcomes.
 */
export function retryStorm({ clients, attempt, isRetryable = () => true, maxAttempts = 8 }) {
  return Array.from({ length: clients }, (_, clientIndex) => async (scheduler) => {
    let lastError;
    for (let n = 1; n <= maxAttempts; n += 1) {
      try {
        const value = await attempt({ clientIndex, attempt: n, scheduler });
        return { ok: true, attempts: n, value };
      } catch (error) {
        lastError = error;
        if (!isRetryable(error)) break;
        await scheduler.yield(`backoff:${clientIndex}`);
      }
    }
    return { ok: false, error: lastError };
  });
}

/** Unwrap `Promise.allSettled` results, surfacing any unexpected actor crash. */
export function settledValues(results) {
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}
