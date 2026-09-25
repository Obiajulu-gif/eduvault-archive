import assert from "node:assert/strict";
import { test } from "node:test";

import {
  validatePinataResponse,
  validateGatewayUrl,
  retryWithBackoff,
  StorageError,
} from "../../src/lib/api/storage.js";

test("validatePinataResponse accepts valid pinata response", () => {
  const response = { cid: "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco" };
  const validated = validatePinataResponse(response, "document");
  assert.deepEqual(validated, response);
});

test("validatePinataResponse throws on invalid response", () => {
  assert.throws(() => validatePinataResponse(null, "document"), StorageError);
  assert.throws(() => validatePinataResponse({}, "document"), StorageError);
  assert.throws(() => validatePinataResponse({ cid: 123 }, "document"), StorageError);
  assert.throws(() => validatePinataResponse({ cid: "" }, "document"), StorageError);
});

test("validateGatewayUrl accepts valid URLs", () => {
  const url = "https://gateway.pinata.cloud/ipfs/QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco";
  const validated = validateGatewayUrl(url, "document");
  assert.equal(validated, url);
});

test("validateGatewayUrl throws on invalid URLs", () => {
  assert.throws(() => validateGatewayUrl(null, "document"), StorageError);
  assert.throws(() => validateGatewayUrl("", "document"), StorageError);
  assert.throws(() => validateGatewayUrl("ftp://invalid-scheme", "document"), StorageError);
});

test("retryWithBackoff succeeds on first attempt", async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    return "success";
  };
  const res = await retryWithBackoff(fn, 3, 10);
  assert.equal(res, "success");
  assert.equal(calls, 1);
});

test("retryWithBackoff retries and succeeds", async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls < 3) {
      throw new Error("transient error");
    }
    return "success";
  };
  let retriedCalls = 0;
  const res = await retryWithBackoff(fn, 4, 10, () => {
    retriedCalls++;
  });
  assert.equal(res, "success");
  assert.equal(calls, 3);
  assert.equal(retriedCalls, 2);
});

test("retryWithBackoff throws error after final failure", async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    throw new Error("permanent error");
  };
  await assert.rejects(async () => {
    await retryWithBackoff(fn, 3, 10);
  }, /permanent error/);
  assert.equal(calls, 3);
});
