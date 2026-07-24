import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeWalletAddress } from "../walletAddress.js";

test("normalizes a valid Stellar account", () => {
  const address = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  assert.equal(normalizeWalletAddress(address), address.toLowerCase());
});

test("rejects attacker-controlled and malformed identity values", () => {
  assert.equal(normalizeWalletAddress("victim@example.test"), null);
  assert.equal(normalizeWalletAddress(""), null);
});
