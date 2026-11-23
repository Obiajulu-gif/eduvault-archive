export class AllowlistError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AllowlistError';
    this.details = details;
  }
}

const ALLOWED_URL_SCHEMES = ['http://', 'https://', 'ipfs://', 'ipns://'];

const ALLOWED_DOCUMENT_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'application/zip',
  'application/x-zip-compressed',
];

const ALLOWED_VIDEO_TYPES = [
  'video/mp4',
  'video/mpeg',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm',
  'video/ogg',
  'video/x-matroska',
];

const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
];

const ALLOWED_ARCHIVE_TYPES = [
  'application/zip',
  'application/x-zip-compressed',
  'application/x-rar-compressed',
  'application/x-7z-compressed',
  'application/gzip',
];

export const ALLOWED_FILE_TYPES = {
  documents: ALLOWED_DOCUMENT_TYPES,
  videos: ALLOWED_VIDEO_TYPES,
  images: ALLOWED_IMAGE_TYPES,
  archives: ALLOWED_ARCHIVE_TYPES,
  all: [...ALLOWED_DOCUMENT_TYPES, ...ALLOWED_VIDEO_TYPES, ...ALLOWED_IMAGE_TYPES],
};

export function validateUrlScheme(url, field = 'url') {
  if (!url) return;

  const urlLower = url.toLowerCase().trim();
  const hasAllowedScheme = ALLOWED_URL_SCHEMES.some(scheme =>
    urlLower.startsWith(scheme)
  );

  if (!hasAllowedScheme) {
    throw new AllowlistError(`Unsafe or disallowed URL scheme for ${field}`, {
      field,
      url: urlLower.substring(0, 50),
    });
  }

  return urlLower;
}

export function validateFileTypeByMime(mimeType, categoryKey = 'all', field = 'file') {
  const category = ALLOWED_FILE_TYPES[categoryKey];

  if (!category) {
    throw new AllowlistError(`Unknown file category: ${categoryKey}`, { categoryKey });
  }

  if (!category.includes(mimeType)) {
    throw new AllowlistError(
      `File type not allowed for ${categoryKey}: ${mimeType}`,
      { field, mimeType, categoryKey }
    );
  }

  return mimeType;
}

export function validateUploadDestination(destination, { allowed = ['pinata', 'ipfs'] } = {}) {
  if (!destination) {
    throw new AllowlistError('Destination is required', { destination });
  }

  const normalizedDest = destination.toLowerCase().trim();

  if (!allowed.includes(normalizedDest)) {
    throw new AllowlistError(
      `Upload destination not allowed: ${normalizedDest}. Allowed: ${allowed.join(', ')}`,
      { destination: normalizedDest, allowed }
    );
  }

  return normalizedDest;
}

export function getAllowlistConfig() {
  return {
    urlSchemes: ALLOWED_URL_SCHEMES,
    fileTypes: ALLOWED_FILE_TYPES,
    destinations: ['pinata', 'ipfs'],
    imageMimeTypes: ALLOWED_IMAGE_TYPES,
    videoMimeTypes: ALLOWED_VIDEO_TYPES,
    documentMimeTypes: ALLOWED_DOCUMENT_TYPES,
    archiveMimeTypes: ALLOWED_ARCHIVE_TYPES,
  };
}
