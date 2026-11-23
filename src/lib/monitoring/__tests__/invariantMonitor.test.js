import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  INVARIANT,
  SEVERITY,
  checkBalanceDelta,
  checkBalanceMinimum,
  checkOwnershipConsistency,
  checkOwnershipUniqueness,
  resetViolationSink,
  runInvariantSuite,
  setViolationSink,
} from "../invariantMonitor.js";

let captured;

beforeEach(() => {
  captured = [];
  setViolationSink((v) => captured.push(v));
});

afterEach(() => {
  resetViolationSink();
});

describe("checkBalanceMinimum", () => {
  it("passes when balance meets the minimum", () => {
    const result = checkBalanceMinimum({ address: "GABC", balance: 100, minimumReserve: 50 });
    expect(result.ok).toBe(true);
    expect(result.violation).toBeUndefined();
    expect(captured).toHaveLength(0);
  });

  it("passes when balance equals the minimum exactly", () => {
    const result = checkBalanceMinimum({ address: "GABC", balance: 50, minimumReserve: 50 });
    expect(result.ok).toBe(true);
  });

  it("fails and emits a violation when balance is below minimum", () => {
    const result = checkBalanceMinimum({ address: "GABC", balance: 30, minimumReserve: 50 });
    expect(result.ok).toBe(false);
    expect(result.violation.invariant).toBe(INVARIANT.BALANCE_MINIMUM);
    expect(result.violation.severity).toBe(SEVERITY.CRITICAL);
    expect(result.violation.context.deficit).toBe(20);
    expect(captured).toHaveLength(1);
  });

  it("throws on non-numeric inputs", () => {
    expect(() =>
      checkBalanceMinimum({ address: "GABC", balance: "50", minimumReserve: 50 })
    ).toThrow(TypeError);
  });
});

describe("checkBalanceDelta", () => {
  it("passes when delta is within bounds", () => {
    const result = checkBalanceDelta({ address: "GABC", delta: 10, maxDebit: 100, maxCredit: 100 });
    expect(result.ok).toBe(true);
  });

  it("passes when delta exactly equals max debit (negated)", () => {
    const result = checkBalanceDelta({ address: "GABC", delta: -100, maxDebit: 100, maxCredit: 100 });
    expect(result.ok).toBe(true);
  });

  it("fails on excess debit", () => {
    const result = checkBalanceDelta({ address: "GABC", delta: -150, maxDebit: 100, maxCredit: 200 });
    expect(result.ok).toBe(false);
    expect(result.violation.invariant).toBe(INVARIANT.BALANCE_DELTA);
    expect(result.violation.severity).toBe(SEVERITY.HIGH);
    expect(captured).toHaveLength(1);
  });

  it("fails on excess credit", () => {
    const result = checkBalanceDelta({ address: "GABC", delta: 300, maxDebit: 100, maxCredit: 200 });
    expect(result.ok).toBe(false);
    expect(result.violation.invariant).toBe(INVARIANT.BALANCE_DELTA);
  });

  it("throws on non-numeric inputs", () => {
    expect(() =>
      checkBalanceDelta({ address: "GABC", delta: "10", maxDebit: 100, maxCredit: 100 })
    ).toThrow(TypeError);
  });
});

describe("checkOwnershipConsistency", () => {
  it("passes when every entitlement has a matching ownership", () => {
    const entitlements = [{ userId: "u1", materialId: "m1" }];
    const ownerships = [{ userId: "u1", materialId: "m1" }];
    const result = checkOwnershipConsistency({ entitlements, ownerships });
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("fails when an entitlement has no ownership record", () => {
    const entitlements = [
      { userId: "u1", materialId: "m1" },
      { userId: "u2", materialId: "m2" },
    ];
    const ownerships = [{ userId: "u1", materialId: "m1" }];
    const result = checkOwnershipConsistency({ entitlements, ownerships });
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].invariant).toBe(INVARIANT.OWNERSHIP_CONSISTENCY);
    expect(captured).toHaveLength(1);
  });

  it("passes for empty inputs", () => {
    const result = checkOwnershipConsistency({ entitlements: [], ownerships: [] });
    expect(result.ok).toBe(true);
  });
});

describe("checkOwnershipUniqueness", () => {
  it("passes for unique ownerships", () => {
    const ownerships = [
      { userId: "u1", materialId: "m1" },
      { userId: "u2", materialId: "m1" },
    ];
    const result = checkOwnershipUniqueness(ownerships);
    expect(result.ok).toBe(true);
  });

  it("fails on duplicate ownership records", () => {
    const ownerships = [
      { userId: "u1", materialId: "m1" },
      { userId: "u1", materialId: "m1" },
    ];
    const result = checkOwnershipUniqueness(ownerships);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe(SEVERITY.MEDIUM);
    expect(captured).toHaveLength(1);
  });
});

describe("runInvariantSuite", () => {
  it("reports passed:true when all checks pass", () => {
    const { passed, results } = runInvariantSuite({
      balanceCheck: { address: "GABC", balance: 100, minimumReserve: 50 },
      deltaCheck: { address: "GABC", delta: 10, maxDebit: 100, maxCredit: 200 },
      entitlements: [{ userId: "u1", materialId: "m1" }],
      ownerships: [{ userId: "u1", materialId: "m1" }],
    });
    expect(passed).toBe(true);
    expect(results.balanceMinimum.ok).toBe(true);
    expect(results.balanceDelta.ok).toBe(true);
    expect(results.ownershipConsistency.ok).toBe(true);
    expect(results.ownershipUniqueness.ok).toBe(true);
  });

  it("reports passed:false when any check fails", () => {
    const { passed, results } = runInvariantSuite({
      balanceCheck: { address: "GABC", balance: 10, minimumReserve: 50 },
      entitlements: [],
      ownerships: [],
    });
    expect(passed).toBe(false);
    expect(results.balanceMinimum.ok).toBe(false);
  });

  it("skips balance checks when params are not provided", () => {
    const { passed, results } = runInvariantSuite({
      entitlements: [{ userId: "u1", materialId: "m1" }],
      ownerships: [{ userId: "u1", materialId: "m1" }],
    });
    expect(passed).toBe(true);
    expect(results.balanceMinimum).toBeUndefined();
    expect(results.balanceDelta).toBeUndefined();
  });

  it("forwards all violations to the sink", () => {
    runInvariantSuite({
      balanceCheck: { address: "GABC", balance: 0, minimumReserve: 50 },
      entitlements: [{ userId: "u1", materialId: "m1" }],
      ownerships: [],
    });
    expect(captured.length).toBeGreaterThanOrEqual(2);
  });
});
