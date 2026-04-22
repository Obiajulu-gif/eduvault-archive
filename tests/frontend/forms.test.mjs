import assert from "node:assert/strict";
import { test } from "node:test";

import {
  validateWalletProfile,
  validateUpload,
  validateCheckout,
} from "../../src/lib/forms/validation.js";

test("wallet profile validation accepts a valid profile", () => {
  const errors = validateWalletProfile({
    fullName: "Ada Creator",
    email: "ada@example.com",
    bio: "Short bio",
  });

  assert.deepEqual(errors, {});
});

test("wallet profile validation reports required fields", () => {
  const errors = validateWalletProfile({
    fullName: "",
    email: "bad-email",
    bio: "x".repeat(301),
  });

  assert.equal(errors.fullName, "Please enter your full name.");
  assert.equal(errors.email, "Please enter a valid email address.");
  assert.equal(errors.bio, "Bio should be 300 characters or fewer.");
});

test("upload validation reports missing title and document", () => {
  const errors = validateUpload({
    title: "",
    docFile: null,
    price: "abc",
    description: "x".repeat(501),
  });

  assert.equal(errors.title, "Please add a title for your material.");
  assert.equal(errors.docFile, "Please choose a document to upload.");
  assert.equal(errors.price, "Price must be a valid number.");
  assert.equal(errors.description, "Description must be 500 characters or fewer.");
});

test("checkout validation reports invalid email and unchecked terms", () => {
  const errors = validateCheckout({
    email: "bad-email",
    agreeTerms: false,
  });

  assert.equal(errors.email, "Please enter a valid email address.");
  assert.equal(errors.agreeTerms, "Please confirm the purchase terms.");
});

