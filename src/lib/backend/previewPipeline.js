/**
 * Preview generation pipeline (#638): fetch -> sandbox -> validate -> store.
 *
 * Runs off the request path, in the side-effect worker, when a `preview` intent
 * is leased. Never throws — every outcome is recorded on the `material_previews`
 * row, and nothing here touches the quarantine / entitlement gate on the
 * original file. A material whose preview is not `ready` simply has no preview.
 *
 * Time/space: one bounded network fetch (O(bytes), byte-capped), one O(caps)
 * sandbox run, one O(S) validation, one O(1) store write.
 */

import { getDb } from "@/lib/mongodb";
import { runInPreviewSandbox } from "./previewSandbox";
import { validatePreviewOutput } from "./previewValidation";
import { ensurePreviewRecord, markReady, markFailed, markRejected } from "./previewStore";

const MAX_PREVIEW_INPUT_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

function ipfsGatewayUrl(contentHash) {
  const gateway =
    process.env.NEXT_PUBLIC_GATEWAY_URL || process.env.IPFS_GATEWAY_URL || "https://gateway.pinata.cloud";
  return `${gateway.replace(/\/$/, "")}/ipfs/${encodeURIComponent(contentHash)}`;
}

async function fetchContent(contentHash, fetchImpl) {
  const response = await fetchImpl(ipfsGatewayUrl(contentHash), {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response || !response.ok) {
    throw new Error(`preview fetch failed: HTTP ${response?.status ?? "?"}`);
  }
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PREVIEW_INPUT_BYTES) {
    throw new Error(`preview source exceeds ${MAX_PREVIEW_INPUT_BYTES} bytes`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length > MAX_PREVIEW_INPUT_BYTES) {
    throw new Error(`preview source exceeds ${MAX_PREVIEW_INPUT_BYTES} bytes`);
  }
  return buf;
}

/**
 * @param {object} args
 * @param {import('mongodb').Db} [args.db]
 * @param {string} args.contentHash
 * @param {string} [args.mimeType]
 * @param {number} [args.sizeBytes]
 * @param {string} [args.materialId]
 * @param {typeof fetch} [args.fetchImpl]
 * @param {object} [args.limits]  Forwarded to the sandbox.
 * @returns {Promise<{ state: string, reason?: string }>}
 */
export async function runPreviewPipeline({
  db,
  contentHash,
  mimeType = "",
  sizeBytes = null,
  materialId = null,
  fetchImpl = globalThis.fetch,
  limits = {},
} = {}) {
  if (!contentHash) return { state: "failed", reason: "missing contentHash" };
  const database = db || (await getDb());

  await ensurePreviewRecord(database, { contentHash, materialId, mimeType, sizeBytes });

  let bytes;
  try {
    if (typeof fetchImpl !== "function") throw new Error("no fetch implementation available");
    bytes = await fetchContent(contentHash, fetchImpl);
  } catch (err) {
    await markFailed(database, contentHash, err?.message || err);
    return { state: "failed", reason: String(err?.message || err) };
  }

  const sandbox = await runInPreviewSandbox({ input: bytes, mimeType, limits });
  if (sandbox.status !== "ok") {
    if (sandbox.status === "rejected") {
      await markRejected(database, contentHash, sandbox.reason || "sandbox rejected input");
      return { state: "rejected", reason: sandbox.reason };
    }
    await markFailed(database, contentHash, sandbox.reason || `sandbox ${sandbox.status}`);
    return { state: "failed", reason: sandbox.reason };
  }

  const validation = validatePreviewOutput(sandbox.preview, { mimeType });
  if (!validation.ok) {
    await markRejected(database, contentHash, `output validation: ${validation.reason}`);
    return { state: "rejected", reason: validation.reason };
  }

  await markReady(database, contentHash, validation.descriptor, sandbox.previewerVersion || null);
  return { state: "ready" };
}
