/**
 * Safe public permalink behavior for renamed or archived records — Issue #895
 *
 * Provides canonical permalink resolution, redirect behavior for renamed
 * records, and access control for archived, deleted, and restricted materials.
 *
 * Design:
 *   - Canonical permalink is always `/marketplace/{_id}` (ObjectId-based)
 *   - Slug-based URLs redirect to the canonical URL when the slug changes
 *   - Archived materials return 410 Gone
 *   - Deleted materials return 404 Not Found
 *   - Private materials return 403 Forbidden for unauthorized users
 *   - Public materials return 200 OK
 */

export const PERMALINK_STATUS = Object.freeze({
  OK: 200,
  REDIRECT: 301,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  GONE: 410,
});

export function buildPermalinkPath(material) {
  if (!material || !material._id) return null;
  return `/marketplace/${material._id}`;
}

export function resolveCanonicalPermalink(material) {
  if (!material || !material._id) return null;
  return {
    url: buildPermalinkPath(material),
    materialId: String(material._id),
  };
}

export function resolvePermalinkRedirect(material, oldSlug) {
  if (!material || !material._id) return null;

  const canonicalUrl = buildPermalinkPath(material);
  const currentSlug = material.slug || material.title
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || '';

  if (!oldSlug || oldSlug === currentSlug) {
    return { needsRedirect: false, canonicalUrl };
  }

  return {
    needsRedirect: true,
    from: oldSlug,
    to: currentSlug,
    canonicalUrl,
    status: PERMALINK_STATUS.REDIRECT,
  };
}

export function isRecordAccessible(material) {
  if (!material) return { accessible: false, status: PERMALINK_STATUS.NOT_FOUND };
  if (material.isDeleted) return { accessible: false, status: PERMALINK_STATUS.NOT_FOUND };
  if (material.archived) return { accessible: false, status: PERMALINK_STATUS.GONE };
  return { accessible: true, status: PERMALINK_STATUS.OK };
}

export function checkPermalinkAccess(material, requesterAddress) {
  if (!material || !material._id) {
    return { allowed: false, status: PERMALINK_STATUS.NOT_FOUND, redirectUrl: null };
  }

  if (material.isDeleted) {
    return { allowed: false, status: PERMALINK_STATUS.NOT_FOUND, redirectUrl: null };
  }

  if (material.archived) {
    return { allowed: false, status: PERMALINK_STATUS.GONE, redirectUrl: null };
  }

  const visibility = material.visibility || 'public';
  const isOwner = requesterAddress && (
    material.userAddress === requesterAddress ||
    material.ownerAddress === requesterAddress ||
    material.creatorAddress === requesterAddress
  );

  if (visibility === 'private' && !isOwner) {
    return { allowed: false, status: PERMALINK_STATUS.FORBIDDEN, redirectUrl: null };
  }

  const canonicalUrl = buildPermalinkPath(material);
  return { allowed: true, status: PERMALINK_STATUS.OK, redirectUrl: canonicalUrl };
}

export function resolvePermalink(material, { oldSlug = null, requesterAddress = null } = {}) {
  const access = checkPermalinkAccess(material, requesterAddress);

  if (!access.allowed) {
    return {
      status: access.status,
      redirectUrl: null,
      material: null,
    };
  }

  if (oldSlug) {
    const redirect = resolvePermalinkRedirect(material, oldSlug);
    if (redirect?.needsRedirect) {
      return {
        status: PERMALINK_STATUS.REDIRECT,
        redirectUrl: redirect.canonicalUrl,
        material: sanitizePublicMaterial(material),
      };
    }
  }

  return {
    status: PERMALINK_STATUS.OK,
    redirectUrl: access.redirectUrl,
    material: sanitizePublicMaterial(material),
  };
}

function sanitizePublicMaterial(material) {
  if (!material) return null;
  const { storageKey, fileUrl, metadataUrl, ...safe } = material;
  return safe;
}
