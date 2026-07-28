/**
 * Publishing checklist — validates that a material has the required
 * and recommended fields populated before it can be published.
 *
 * Separates checks into two tiers:
 *   - REQUIRED (blocking): material cannot be published without these.
 *   - RECOMMENDED (quality): material can be published but creator
 *     should be informed of gaps.
 */

// ── Field definitions ────────────────────────────────────────────────────────

import { QUARANTINE_STATES } from '@/lib/publishing/quarantine';

export const PUBLISH_REQUIRED_FIELDS = [
  {
    key: "file",
    label: "Uploaded file",
    description: "A file must be uploaded before the material can be published.",
    check: (m) => !!(m.storageKey || m.fileUrl || m.ipfsCid || m.cid || m.fileHash),
  },
  {
    key: "title",
    label: "Title",
    description: "A descriptive title helps learners find your material.",
    check: (m) => !!(m.title && String(m.title).trim().length > 0),
  },
  {
    key: "quarantine",
    label: "Malware scan",
    description: "The uploaded content must complete malware scanning and be marked clean.",
    check: (m) => m.quarantineState === QUARANTINE_STATES.CLEAN,
  },
];

export const PUBLISH_RECOMMENDED_FIELDS = [
  {
    key: "description",
    label: "Description",
    description: "A description helps learners understand what your material covers.",
    check: (m) => !!(m.description || m.shortSummary),
  },
  {
    key: "thumbnail",
    label: "Thumbnail / Cover image",
    description: "A visual thumbnail makes your material stand out in listings.",
    check: (m) => !!(m.coverImageUrl || m.thumbnailUrl || m.image),
  },
  {
    key: "price",
    label: "Price",
    description: "Set a price (even 0) so learners know whether the material is free or paid.",
    check: (m) => m.price !== undefined && m.price !== null && m.price !== "",
  },
  {
    key: "usageRights",
    label: "Usage rights",
    description: "Specify the license so learners know how they can use the material.",
    check: (m) => !!(m.usageRights && String(m.usageRights).trim().length > 0),
  },
  {
    key: "visibility",
    label: "Visibility",
    description: "Choose whether the material is public, private, or unlisted.",
    check: (m) => !!(m.visibility && ["public", "private", "unlisted"].includes(m.visibility)),
  },
  {
    key: "category",
    label: "Category",
    description: "Categorisation helps learners filter and discover your material.",
    check: (m) => !!(m.category && String(m.category).trim().length > 0),
  },
  {
    key: "subject",
    label: "Subject",
    description: "Subject tags help learners find relevant materials.",
    check: (m) => !!(m.subject && String(m.subject).trim().length > 0),
  },
  {
    key: "level",
    label: "Level",
    description: "Indicate the target audience level (beginner, intermediate, advanced).",
    check: (m) => !!(m.level && String(m.level).trim().length > 0),
  },
  {
    key: "learningOutcomes",
    label: "Learning outcomes",
    description: "List what learners will achieve — improves engagement and discoverability.",
    check: (m) => !!(m.learningOutcomes && Array.isArray(m.learningOutcomes) && m.learningOutcomes.length > 0),
  },
  {
    key: "tableOfContents",
    label: "Table of contents",
    description: "A table of contents helps learners preview the material structure.",
    check: (m) => !!(m.tableOfContents && Array.isArray(m.tableOfContents) && m.tableOfContents.length > 0),
  },
];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Evaluate a material against the publishing checklist.
 *
 * @param {object} material - The material document from the database.
 * @returns {{ required: Array, recommended: Array, missingRequired: Array, missingRecommended: Array }}
 */
export function getPublishingChecklist(material) {
  if (!material) {
    const allRequired = PUBLISH_REQUIRED_FIELDS.map((f) => ({ ...f, met: false }));
    const allRecommended = PUBLISH_RECOMMENDED_FIELDS.map((f) => ({ ...f, met: false }));
    return {
      required: allRequired,
      recommended: allRecommended,
      missingRequired: allRequired.map((f) => f.key),
      missingRecommended: allRecommended.map((f) => f.key),
    };
  }

  const required = PUBLISH_REQUIRED_FIELDS.map((field) => ({
    key: field.key,
    label: field.label,
    description: field.description,
    met: field.check(material),
  }));

  const recommended = PUBLISH_RECOMMENDED_FIELDS.map((field) => ({
    key: field.key,
    label: field.label,
    description: field.description,
    met: field.check(material),
  }));

  return {
    required,
    recommended,
    missingRequired: required.filter((f) => !f.met).map((f) => f.key),
    missingRecommended: recommended.filter((f) => !f.met).map((f) => f.key),
  };
}

/**
 * Quick check whether a material is ready to publish.
 *
 * @param {object} material - The material document.
 * @returns {{ ready: boolean, checklist: object, missingRequired: string[] }}
 */
export function isReadyToPublish(material) {
  const checklist = getPublishingChecklist(material);
  return {
    ready: checklist.missingRequired.length === 0,
    checklist,
    missingRequired: checklist.missingRequired,
  };
}

/**
 * Validate a publish request, returning an error response if the material
 * is not ready or the user is not authorised.
 *
 * @param {object} material - The material document from the database.
 * @param {string} userAddress - The authenticated user's wallet address.
 * @returns {{ valid: boolean, error?: string, status?: number, checklist?: object }}
 */
export function validatePublishRequest(material, userAddress) {
  // Material existence
  if (!material) {
    return { valid: false, error: "Material not found", status: 404 };
  }

  // Ownership
  const owner = material.userAddress || material.ownerAddress;
  if (!owner || String(owner).toLowerCase() !== String(userAddress).toLowerCase()) {
    return { valid: false, error: "Only the material owner can publish", status: 403 };
  }

  // Completeness
  const { ready, checklist, missingRequired } = isReadyToPublish(material);
  if (!ready) {
    return {
      valid: false,
      error: "Cannot publish: required fields are missing",
      status: 400,
      checklist,
    };
  }

  // Already published
  if (material.status === "published") {
    return {
      valid: true,
      alreadyPublished: true,
      checklist,
    };
  }

  return { valid: true, checklist };
}
