/**
 * src/lib/marketplace/duplicateDetection.js
 *
 * Deterministic duplicate detection engine for EduVault (#961).
 *
 * Implements reproducible content fingerprinting and multi-signal similarity
 * scoring across educational materials, protecting marketplace integrity,
 * creator attribution, and archive safety.
 */

import { createHash } from 'node:crypto';

export const DUPLICATE_REASONS = Object.freeze({
  EXACT_CONTENT_HASH: 'EXACT_CONTENT_HASH',
  IDENTICAL_ASSET_CID: 'IDENTICAL_ASSET_CID',
  IDENTICAL_CREATOR_AND_TITLE: 'IDENTICAL_CREATOR_AND_TITLE',
  HIGH_SIMILARITY_METADATA: 'HIGH_SIMILARITY_METADATA',
});

export const DEFAULT_SIMILARITY_THRESHOLD = 0.85;

/**
 * Normalizes string for deterministic text matching:
 * - NFKC unicode normalization
 * - lowercasing
 * - removal of non-alphanumeric punctuation
 * - whitespace normalization
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  if (typeof text !== 'string') return '';
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generates sorted unique token set from normalized text.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function tokenize(text) {
  const normalized = normalizeText(text);
  if (!normalized) return new Set();
  const tokens = normalized.split(' ').filter((t) => t.length > 1);
  return new Set(tokens);
}

/**
 * Calculates Jaccard similarity coefficient between two sets of tokens.
 *
 * @param {Set<string>} setA
 * @param {Set<string>} setB
 * @returns {number} Value between 0.0 and 1.0
 */
export function calculateJaccardSimilarity(setA, setB) {
  if (!setA.size && !setB.size) return 1.0;
  if (!setA.size || !setB.size) return 0.0;

  let intersectionSize = 0;
  for (const item of setA) {
    if (setB.has(item)) intersectionSize++;
  }

  const unionSize = setA.size + setB.size - intersectionSize;
  return unionSize === 0 ? 0 : Number((intersectionSize / unionSize).toFixed(4));
}

/**
 * Computes deterministic SHA-256 fingerprint for material canonical attributes.
 *
 * @param {object} material
 * @returns {string} Hex SHA-256 digest
 */
export function computeContentFingerprint(material) {
  if (!material || typeof material !== 'object') {
    throw new TypeError('Material object is required to compute fingerprint');
  }

  const canonicalPayload = {
    cid: material.cid ? String(material.cid).trim() : '',
    contentHash: material.contentHash ? String(material.contentHash).trim().toLowerCase() : '',
    title: normalizeText(material.title || ''),
    description: normalizeText(material.description || ''),
    subject: normalizeText(material.subject || ''),
    category: normalizeText(material.category || ''),
    creator: material.creator ? String(material.creator).trim().toLowerCase() : '',
    tags: Array.isArray(material.tags)
      ? Array.from(new Set(material.tags.map(normalizeText).filter(Boolean))).sort()
      : [],
    fileSize: typeof material.fileSize === 'number' ? material.fileSize : 0,
    mimeType: material.mimeType ? String(material.mimeType).trim().toLowerCase() : '',
  };

  const serialized = JSON.stringify(canonicalPayload);
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/**
 * Compares two materials and determines if they are candidate duplicates.
 *
 * @param {object} matA
 * @param {object} matB
 * @param {object} [options]
 * @param {number} [options.threshold=0.85]
 * @returns {{ isDuplicate: boolean, score: number, reasons: string[], fingerprintA: string, fingerprintB: string }}
 */
export function compareMaterials(matA, matB, options = {}) {
  const threshold = options.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const reasons = [];

  const fpA = computeContentFingerprint(matA);
  const fpB = computeContentFingerprint(matB);

  // 1. Exact canonical fingerprint match
  if (fpA === fpB) {
    return {
      isDuplicate: true,
      score: 1.0,
      reasons: [DUPLICATE_REASONS.EXACT_CONTENT_HASH],
      fingerprintA: fpA,
      fingerprintB: fpB,
    };
  }

  // 2. Exact IPFS CID match (if present on both)
  if (matA.cid && matB.cid && String(matA.cid).trim() === String(matB.cid).trim()) {
    reasons.push(DUPLICATE_REASONS.IDENTICAL_ASSET_CID);
  }

  // 3. Exact raw content hash match (e.g. SHA-256 of payload file)
  if (
    matA.contentHash &&
    matB.contentHash &&
    String(matA.contentHash).trim().toLowerCase() === String(matB.contentHash).trim().toLowerCase()
  ) {
    if (!reasons.includes(DUPLICATE_REASONS.EXACT_CONTENT_HASH)) {
      reasons.push(DUPLICATE_REASONS.EXACT_CONTENT_HASH);
    }
  }

  // If exact content or CID matches, score is at least 0.99
  if (reasons.length > 0) {
    return {
      isDuplicate: true,
      score: 0.99,
      reasons,
      fingerprintA: fpA,
      fingerprintB: fpB,
    };
  }

  // 4. Metadata token similarity
  const titleA = normalizeText(matA.title || '');
  const titleB = normalizeText(matB.title || '');
  const creatorA = String(matA.creator || '').trim().toLowerCase();
  const creatorB = String(matB.creator || '').trim().toLowerCase();

  if (titleA && titleB && titleA === titleB && creatorA && creatorB && creatorA === creatorB) {
    reasons.push(DUPLICATE_REASONS.IDENTICAL_CREATOR_AND_TITLE);
  }

  const tokensA = tokenize(`${matA.title || ''} ${matA.description || ''} ${(matA.tags || []).join(' ')}`);
  const tokensB = tokenize(`${matB.title || ''} ${matB.description || ''} ${(matB.tags || []).join(' ')}`);

  const similarityScore = calculateJaccardSimilarity(tokensA, tokensB);

  let finalScore = similarityScore;
  if (reasons.includes(DUPLICATE_REASONS.IDENTICAL_CREATOR_AND_TITLE)) {
    finalScore = Math.max(0.95, similarityScore);
  } else if (titleA && titleB && titleA === titleB) {
    finalScore = Math.max(0.90, similarityScore);
  }

  finalScore = Number(finalScore.toFixed(4));

  if (finalScore >= threshold) {
    reasons.push(DUPLICATE_REASONS.HIGH_SIMILARITY_METADATA);
  }

  return {
    isDuplicate: finalScore >= threshold,
    score: finalScore,
    reasons,
    fingerprintA: fpA,
    fingerprintB: fpB,
  };
}

/**
 * Scans a collection of materials deterministically and returns all candidate duplicate pairs.
 * Pairs are deterministically ordered: the older material (by createdAt / materialId) is
 * chosen as canonical, and the newer as candidate duplicate.
 *
 * @param {Array<object>} materials
 * @param {object} [options]
 * @param {number} [options.threshold=0.85]
 * @returns {Array<object>} Candidate duplicate review pairs
 */
export function detectDuplicates(materials, options = {}) {
  if (!Array.isArray(materials)) return [];
  const threshold = options.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;

  // Sort deterministically by createdAt, then materialId
  const sorted = [...materials].sort((a, b) => {
    const timeA = new Date(a.createdAt || 0).getTime();
    const timeB = new Date(b.createdAt || 0).getTime();
    if (timeA !== timeB) return timeA - timeB;
    return String(a.materialId || a._id || '').localeCompare(String(b.materialId || b._id || ''));
  });

  const candidates = [];

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const matA = sorted[i];
      const matB = sorted[j];

      const idA = String(matA.materialId || matA._id);
      const idB = String(matB.materialId || matB._id);

      // Skip already merged materials
      if (matA.status === 'merged' || matB.status === 'merged') continue;

      const comparison = compareMaterials(matA, matB, { threshold });
      if (comparison.isDuplicate) {
        // Earlier item is canonical, later is candidate duplicate
        candidates.push({
          canonicalId: idA,
          duplicateId: idB,
          score: comparison.score,
          reasons: comparison.reasons,
          fingerprintCanonical: comparison.fingerprintA,
          fingerprintDuplicate: comparison.fingerprintB,
          detectedAt: new Date().toISOString(),
        });
      }
    }
  }

  return candidates;
}
