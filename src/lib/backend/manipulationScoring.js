import crypto from "node:crypto";

const DEFAULTS = {
  maxKeywordDensity: Number(process.env.MANIPULATION_MAX_KEYWORD_DENSITY || 0.12),
  nearDuplicateSimilarity: Number(process.env.MANIPULATION_NEAR_DUPLICATE_SIMILARITY || 0.82),
};

function tokens(value) {
  return String(value || "").toLowerCase().match(/[a-z0-9]{3,}/g) || [];
}

function shingles(value) {
  const words = tokens(value);
  return new Set(words.slice(0, -1).map((word, index) => `${word}:${words[index + 1]}`));
}

function similarity(left, right) {
  const a = shingles(left);
  const b = shingles(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const value of a) if (b.has(value)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

export function scoreListingManipulation(material, creatorMaterials = [], thresholds = DEFAULTS) {
  const titleTokens = tokens(material.title);
  const bodyTokens = tokens(`${material.description || ""} ${material.shortSummary || ""}`);
  const titleSet = new Set(titleTokens);
  const density = titleTokens.length ? titleTokens.filter((token) => bodyTokens.includes(token)).length / titleTokens.length : 0;
  const duplicate = creatorMaterials
    .filter((candidate) => String(candidate._id) !== String(material._id))
    .map((candidate) => ({ materialId: String(candidate._id), similarity: similarity(`${material.title} ${material.description}`, `${candidate.title} ${candidate.description}`) }))
    .sort((a, b) => b.similarity - a.similarity)[0] || null;
  const reasons = [];
  if (titleSet.size >= 4 && density > thresholds.maxKeywordDensity) reasons.push("keyword_density_anomaly");
  if (duplicate && duplicate.similarity >= thresholds.nearDuplicateSimilarity) reasons.push("near_duplicate_listing");
  return {
    score: Math.min(1, (reasons.length * 0.35) + (duplicate?.similarity || 0) * 0.3),
    flagged: reasons.length > 0,
    reasons,
    nearDuplicate: duplicate,
    policyVersion: crypto.createHash("sha1").update(JSON.stringify(thresholds)).digest("hex").slice(0, 12),
  };
}

export async function evaluateAndQueueListing(db, material, { now = new Date() } = {}) {
  const creator = material.userAddress || material.creatorAddress || material.creatorId;
  const creatorMaterials = creator ? await db.collection("materials").find({ userAddress: creator }).toArray() : [];
  const assessment = scoreListingManipulation(material, creatorMaterials);
  await db.collection("materials").updateOne(
    { _id: material._id },
    { $set: { manipulationAssessment: assessment, manipulationScoredAt: now, ...(assessment.flagged ? { moderationStatus: "pending_review", discoveryReviewStatus: "flagged" } : {}) } },
  );
  if (assessment.flagged) {
    await db.collection("moderation_cases").updateOne(
      { materialId: material._id, caseType: "ranking_manipulation", status: { $nin: ["closed", "sanctioned"] } },
      { $setOnInsert: { materialId: material._id, caseType: "ranking_manipulation", status: "open", createdAt: now, policyVersion: assessment.policyVersion }, $set: { reasons: assessment.reasons, score: assessment.score, nearDuplicate: assessment.nearDuplicate, updatedAt: now } },
      { upsert: true },
    );
  }
  return assessment;
}