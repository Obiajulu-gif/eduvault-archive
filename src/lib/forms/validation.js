import { sanitizeString } from "../api/validation.js";

const MAX_TITLE_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_DOC_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_THUMB_SIZE_BYTES = 5 * 1024 * 1024;

const USAGE_RIGHTS_OPTIONS = new Set([
  "Standard License (download only)",
  "Creative Commons",
  "Private Use Only",
]);

const VISIBILITY_OPTIONS = new Set(["public", "private"]);

function cloneValues(values) {
  return { ...(values || {}) };
}

export function createFormState(values) {
  return {
    values: cloneValues(values),
    errors: {},
    submitError: null,
    isSubmitting: false,
  };
}

export function setFieldState(state, field, value) {
  const { [field]: _removed, ...nextErrors } = state.errors || {};
  return {
    ...state,
    values: {
      ...state.values,
      [field]: value,
    },
    errors: nextErrors,
    submitError: null,
  };
}

export function setSubmitting(state, isSubmitting) {
  return {
    ...state,
    isSubmitting,
    submitError: isSubmitting ? null : state.submitError,
  };
}

export function validateUpload(values = {}) {
  const errors = {};
  const title = sanitizeString(values.title, { maxLength: MAX_TITLE_LENGTH });
  const rawDescription = typeof values.description === "string" ? values.description : "";
  const usageRights = sanitizeString(values.usageRights, { maxLength: 120 });
  const visibility = sanitizeString(values.visibility, { maxLength: 20 }) || "public";
  const price = sanitizeString(values.price, { maxLength: 32 });

  if (!title) {
    errors.title = "Document title is required.";
  }

  if (!values.docFile) {
    errors.docFile = "Please upload a document file.";
  } else if (typeof values.docFile.size === "number" && values.docFile.size > MAX_DOC_SIZE_BYTES) {
    errors.docFile = "Document file must be 10MB or smaller.";
  }

  if (rawDescription.length > MAX_DESCRIPTION_LENGTH) {
    errors.description = "Description must be 5000 characters or fewer.";
  }

  if (price) {
    const parsedPrice = Number(price);
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
      errors.price = "Price must be a non-negative number.";
    }
  }

  if (usageRights && !USAGE_RIGHTS_OPTIONS.has(usageRights)) {
    errors.usageRights = "Select a valid usage rights option.";
  }

  if (!VISIBILITY_OPTIONS.has(visibility)) {
    errors.visibility = "Select a valid visibility option.";
  }

  if (values.thumbFile && typeof values.thumbFile.size === "number" && values.thumbFile.size > MAX_THUMB_SIZE_BYTES) {
    errors.thumbFile = "Thumbnail image must be 5MB or smaller.";
  }

  if (values.thumbFile && typeof values.thumbFile.type === "string" && !values.thumbFile.type.startsWith("image/")) {
    errors.thumbFile = "Thumbnail must be an image file.";
  }

  return Object.fromEntries(
    Object.entries(errors).filter(([, message]) => Boolean(message))
  );
}
