import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";
import { EVENT_SCHEMAS, schemaKeyForTopics } from "./eventSchema.js";
import { resolveContractKind } from "./contractManifest.js";
import { logger } from "../logger.js";

/**
 * Typed decoder/normalizer for MaterialRegistry and PurchaseManager Soroban
 * events (#7). Turns a raw `getEvents` RPC result item — XDR-encoded topics
 * and a `data_format = "vec"` XDR-encoded value — into the normalized shape
 * `applyIndexedEvent` (stellarIndexer.js) expects, or a `{ skipped: true }`
 * observability record when the event can't be trusted (wrong network,
 * unlisted contract, unknown event/version, malformed payload).
 *
 * Unknown/invalid events are never thrown past this module during batch
 * processing — see `decodeContractEvent`'s return contract below — so one
 * bad event can't block the rest of a batch (acceptance criterion).
 */

/**
 * @typedef {Object} DecodeResult
 * @property {boolean} ok
 * @property {string} [reason] - set when ok is false: "unknown_event" |
 *   "malformed_topics" | "malformed_data" | "unlisted_contract" | "wrong_network"
 * @property {object} [event] - normalized event, set when ok is true
 */

function decodeTopic(topicXdr) {
  const scVal = xdr.ScVal.fromXDR(topicXdr, "base64");
  return scValToNative(scVal);
}

function bytesToHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function stableEventId(rawEvent, networkPassphrase) {
  const identity = [
    networkPassphrase,
    rawEvent.contractId,
    rawEvent.ledger ?? "",
    rawEvent.txHash || rawEvent.transactionHash || "",
    rawEvent.id || rawEvent.pagingToken || "",
  ].join(":");
  return createHash("sha256").update(identity).digest("hex");
}

function coerceField(rawValue, type) {
  switch (type) {
    case "bytes32Hex": {
      if (!(rawValue instanceof Uint8Array) && !Buffer.isBuffer(rawValue)) {
        throw new Error("expected 32-byte value");
      }
      if (rawValue.length !== 32) {
        throw new Error(`expected 32 bytes, got ${rawValue.length}`);
      }
      return bytesToHex(rawValue);
    }
    case "bytes": {
      if (!(rawValue instanceof Uint8Array) && !Buffer.isBuffer(rawValue)) {
        throw new Error("expected bytes value");
      }
      return bytesToHex(rawValue);
    }
    case "address": {
      const strkey = typeof rawValue === "string" ? rawValue : rawValue?.toString?.();
      if (!strkey) throw new Error("expected address value");
      // Throws if not a valid G.../C... StrKey — this is our address validation.
      Address.fromString(strkey);
      return strkey;
    }
    case "string": {
      if (typeof rawValue !== "string") throw new Error("expected string value");
      return rawValue;
    }
    case "symbol": {
      if (typeof rawValue !== "string") throw new Error("expected symbol value");
      return rawValue;
    }
    case "bool": {
      if (typeof rawValue !== "boolean") throw new Error("expected bool value");
      return rawValue;
    }
    case "u32": {
      const n = typeof rawValue === "bigint" ? Number(rawValue) : rawValue;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
        throw new Error("expected non-negative u32 value");
      }
      return n;
    }
    case "u64": {
      const big = typeof rawValue === "bigint" ? rawValue : BigInt(rawValue);
      if (big < 0n) throw new Error("expected non-negative u64 value");
      return big.toString();
    }
    case "i128": {
      const big = typeof rawValue === "bigint" ? rawValue : BigInt(rawValue);
      return big.toString();
    }
    case "any":
    default:
      return rawValue;
  }
}

/**
 * Decodes the ordered `vec` data payload against a schema's field list.
 * Extra trailing elements (additive, backward-compatible schema evolution)
 * are ignored; missing required elements are a decode error.
 */
function decodeDataFields(dataNative, fields) {
  if (!Array.isArray(dataNative)) {
    throw new Error("expected vec data payload");
  }
  if (dataNative.length < fields.length) {
    throw new Error(
      `expected at least ${fields.length} data fields, got ${dataNative.length}`,
    );
  }
  const out = {};
  fields.forEach((field, i) => {
    out[field.name] = coerceField(dataNative[i], field.type);
  });
  return out;
}

/**
 * @param {object} rawEvent - one item from Soroban RPC `getEvents().events`
 *   (`{ contractId, topic: string[], value: string, ledger, id, txHash, ... }`)
 * @param {object} options
 * @param {string} options.networkPassphrase - expected network; events from
 *   any other network are rejected.
 * @param {object} [options.manifestOverrides] - test hook for contractManifest.
 * @returns {DecodeResult}
 */
export function decodeContractEvent(rawEvent, options) {
  const { networkPassphrase, manifestOverrides } = options || {};

  if (!networkPassphrase) {
    throw new Error("decodeContractEvent requires options.networkPassphrase");
  }

  const contractKind = resolveContractKind(
    rawEvent.contractId,
    networkPassphrase,
    manifestOverrides,
  );
  if (!contractKind) {
    logger.warn(
      { contractId: rawEvent.contractId },
      "[EventDecoder] Rejecting event from an unlisted contract/network",
    );
    return { ok: false, reason: "unlisted_contract" };
  }

  const topics = Array.isArray(rawEvent.topic) ? rawEvent.topic : [];
  if (topics.length < 2) {
    return { ok: false, reason: "malformed_topics" };
  }

  let topic0;
  let topic1;
  try {
    topic0 = decodeTopic(topics[0]);
    topic1 = decodeTopic(topics[1]);
  } catch {
    return { ok: false, reason: "malformed_topics" };
  }
  if (typeof topic0 !== "string" || typeof topic1 !== "string") {
    // e.g. the two leading topic positions were swapped with a data topic —
    // event names are always Symbols (decode to strings).
    return { ok: false, reason: "malformed_topics" };
  }

  const schemaKey = schemaKeyForTopics(topic0, topic1);
  if (!schemaKey) {
    logger.info(
      { topic0, topic1 },
      "[EventDecoder] Unknown event/version — skipping, not blocking the batch",
    );
    return { ok: false, reason: "unknown_event" };
  }
  const schema = EVENT_SCHEMAS[schemaKey];
  if (schema.contract !== contractKind) {
    // Same topic pair reused by a different contract than the one that's
    // actually allowlisted to emit it.
    return { ok: false, reason: "unlisted_contract" };
  }

  let dataNative;
  try {
    const dataScVal = xdr.ScVal.fromXDR(rawEvent.value, "base64");
    dataNative = scValToNative(dataScVal);
  } catch {
    return { ok: false, reason: "malformed_data" };
  }

  let fields;
  try {
    fields = decodeDataFields(dataNative, schema.fields);
  } catch (err) {
    logger.warn(
      { schemaKey, error: String(err?.message || err) },
      "[EventDecoder] Malformed event data — skipping, not blocking the batch",
    );
    return { ok: false, reason: "malformed_data" };
  }

  const normalized = {
    eventId: stableEventId(rawEvent, networkPassphrase),
    type: schemaKey,
    schemaVersion: schema.schemaVersion,
    contractId: rawEvent.contractId,
    ledger: rawEvent.ledger ?? null,
    transactionHash: rawEvent.txHash || rawEvent.transactionHash || null,
    id: rawEvent.id || null,
    ...fields,
    raw: rawEvent,
  };

  // Bridge to the field names `applyIndexedEvent` currently reads.
  if (schemaKey === "material.registered") {
    normalized.materialId = fields.materialId;
  }
  if (schemaKey === "purchase.completed") {
    normalized.materialId = fields.materialId;
    normalized.buyerAddress = fields.buyer;
    normalized.sellerAddress = fields.seller;
    normalized.amount = fields.amount;
    normalized.asset = fields.asset;
  }

  return { ok: true, event: normalized };
}
