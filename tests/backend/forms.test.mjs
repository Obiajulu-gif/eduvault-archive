import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFormState,
  setFieldState,
  setSubmitting,
  validateUpload,
} from "../../src/lib/forms/validation.js";

test("createFormState builds a stable upload form state shape", () => {
  const state = createFormState({ title: "Notes", visibility: "public" });

  assert.deepEqual(state, {
    values: { title: "Notes", visibility: "public" },
    errors: {},
    submitError: null,
    isSubmitting: false,
  });
});

test("setFieldState updates a single value and clears field errors", () => {
  const state = createFormState({ title: "" });
  const next = setFieldState(
    {
      ...state,
      errors: { title: "Document title is required." },
      submitError: "Please fix the form.",
    },
    "title",
    "Lecture Notes"
  );

  assert.equal(next.values.title, "Lecture Notes");
  assert.equal(next.errors.title, undefined);
  assert.equal(next.submitError, null);
});

test("setSubmitting flips the submitting flag without disturbing values", () => {
  const state = createFormState({ title: "Notes" });
  const next = setSubmitting(state, true);

  assert.equal(next.isSubmitting, true);
  assert.equal(next.values.title, "Notes");
});

test("validateUpload rejects missing document data and invalid metadata", () => {
  const errors = validateUpload({
    title: "  ",
    description: "x".repeat(6000),
    price: "-1",
    usageRights: "Unknown",
    visibility: "shared",
    docFile: { size: 11 * 1024 * 1024, type: "application/pdf" },
    thumbFile: { size: 6 * 1024 * 1024, type: "text/plain" },
  });

  assert.deepEqual(errors, {
    title: "Document title is required.",
    docFile: "Document file must be 10MB or smaller.",
    description: "Description must be 5000 characters or fewer.",
    price: "Price must be a non-negative number.",
    usageRights: "Select a valid usage rights option.",
    visibility: "Select a valid visibility option.",
    thumbFile: "Thumbnail must be an image file.",
  });
});

test("validateUpload accepts a valid upload payload", () => {
  assert.deepEqual(
    validateUpload({
      title: "Development Economics Notes",
      description: "A concise summary of the lecture.",
      price: "25",
      usageRights: "Creative Commons",
      visibility: "public",
      docFile: { size: 2 * 1024 * 1024, type: "application/pdf" },
      thumbFile: { size: 512 * 1024, type: "image/png" },
    }),
    {}
  );
});
