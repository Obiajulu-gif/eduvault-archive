import { simulatePolicyChange, PolicySimulationError } from "../policies/policySimulator.js";

const MAX_PREVIEW_RECORDS = 25;

/**
 * Stable dry-run boundary for admin callers. The simulator remains pure; this
 * adapter normalizes the affected-record preview so clients do not depend on
 * policy-specific result field names.
 */
export async function evaluatePolicyDryRun({
  policyType,
  proposedPolicy,
  currentPolicy = {},
  dataSource = {},
  actor = {},
  maxPreviewRecords = MAX_PREVIEW_RECORDS,
} = {}) {
  const preview = await simulatePolicyChange({ policyType, proposedPolicy, currentPolicy, dataSource, actor });
  const assessment = preview.impactAssessment || {};
  const sample = assessment.affectedRecordsSample || [];
  return {
    ...preview,
    dryRun: true,
    affectedRecords: {
      count: Number(assessment.affectedRecordsCount || 0),
      sample: sample.slice(0, Math.max(0, Math.min(Number(maxPreviewRecords) || 0, MAX_PREVIEW_RECORDS))),
    },
    writesPerformed: 0,
  };
}

/** Return a safe, deterministic retry key for notification/webhook events. */
export function deliveryDedupeKey({ channel, eventType, sourceId, version = 1 } = {}) {
  if (!channel || !eventType || !sourceId) throw new TypeError("channel, eventType, and sourceId are required");
  return `${String(channel)}:${String(eventType)}:${String(sourceId)}:v${String(version)}`;
}

export { PolicySimulationError };
