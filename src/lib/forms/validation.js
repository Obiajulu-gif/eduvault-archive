const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createFormState(initialValues) {
  return {
    values: { ...initialValues },
    errors: {},
    submitError: null,
    isSubmitting: false,
    touched: {},
  };
}

export function setFieldState(state, field, value) {
  return {
    ...state,
    values: { ...state.values, [field]: value },
    touched: { ...state.touched, [field]: true },
    errors: { ...state.errors, [field]: undefined },
    submitError: null,
  };
}

export function setSubmitError(state, message) {
  return { ...state, submitError: message, isSubmitting: false };
}

export function setSubmitting(state, isSubmitting) {
  return { ...state, isSubmitting };
}

export function validateWalletProfile(values) {
  const errors = {};

  if (!values.fullName || values.fullName.trim().length < 2) {
    errors.fullName = "Please enter your full name.";
  }

  if (!values.email || !emailPattern.test(values.email.trim())) {
    errors.email = "Please enter a valid email address.";
  }

  if (values.bio && values.bio.length > 300) {
    errors.bio = "Bio should be 300 characters or fewer.";
  }

  return errors;
}

export function validateUpload(values) {
  const errors = {};

  if (!values.title || values.title.trim().length < 3) {
    errors.title = "Please add a title for your material.";
  }

  if (!values.docFile) {
    errors.docFile = "Please choose a document to upload.";
  }

  if (values.price && Number.isNaN(Number(values.price))) {
    errors.price = "Price must be a valid number.";
  }

  if (values.description && values.description.length > 500) {
    errors.description = "Description must be 500 characters or fewer.";
  }

  return errors;
}

export function validateCheckout(values) {
  const errors = {};

  if (!values.email || !emailPattern.test(values.email.trim())) {
    errors.email = "Please enter a valid email address.";
  }

  if (!values.agreeTerms) {
    errors.agreeTerms = "Please confirm the purchase terms.";
  }

  return errors;
}

