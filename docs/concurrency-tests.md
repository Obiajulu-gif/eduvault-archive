# Concurrency regression coverage

Run `npm run test:concurrency` to exercise deterministic seeded interleavings for duplicate submissions, stale optimistic versions, transient retry storms, abandoned claims, and authorization races. The suite uses in-memory Mongo-shaped collections and a scheduler that explores multiple execution orders, so a passing run verifies the invariants without requiring a live database. The focused #1060 regression test also ensures authorization rejects a competing writer before a mutation is possible.
