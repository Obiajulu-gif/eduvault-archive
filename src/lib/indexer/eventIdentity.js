import { createHash } from "node:crypto";

/**
 * Deterministic, collision-resistant identity derivation for indexed
 * Stellar/Soroban events (#630).
 *
 * Replaces the indexer's old `Math.random()` dead-letter fallback (only
 * reachable when an event lacked every other identifier) with two guarantees:
 *
 *   1. The same raw event always derives the same id, in any process, on any
 *      retry — every function here is a pure function of its inputs.
 *   2. Two distinct events can never derive the same id, because the id is a
 *      hash of the event's full canonical position: network, contract, ledger,
 *      transaction, operation index, and event position.
 *
 * The "event position" is the source event's own id. For a Soroban RPC
 * `getEvents` event that id is, per Stellar's spec, a 19-character TOID
 * (ledger sequence · transaction application order · operation index) plus a
 * hyphen and a 10-character zero-padded event index — e.g.
 * `0016010972359577600-0000000001`. It is therefore already unique per event
 * within one network's history; `network` and `contractId` extend that so
 * events indexed against two differently-configured networks sharing one
 * database cannot collide on low, reused ledger numbers.
 *
 * An event that cannot supply an event position is "insufficiently identified"
 * and must be quarantined by the caller — never processed, never given a
 * synthetic id.
 */

// Namespaced, versioned id prefix. A future change to the component set
// becomes `evt_v2_` with a matching migration; `planEventIdRewrite` and
// `isLegacyFallbackId` use the prefix to tell generations apart.
const ID_PREFIX = "evt";
const ID_VERSION = "v1";

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Hash a fixed-order tuple of primitives into the `evt_v1_<64 hex>` id form.
 * JSON encoding makes the field boundaries unambiguous without any delimiter
 * escaping (the network passphrase contains spaces and a semicolon), and
 * every element is a string, number, or null, so the digest is fully
 * deterministic.
 *
 * Time/space: O(1) — the tuple's serialized size is constant-bounded
 * (passphrase <= 56, StrKey <= 56, tx hash 64, event id 30, small integers).
 */
function hashTuple(tuple) {
  const digest = createHash("sha256").update(JSON.stringify(tuple)).digest("hex");
  return `${ID_PREFIX}_${ID_VERSION}_${digest}`;
}

/**
 * @param {object} params
 * @param {string} [params.network]          Canonical network passphrase (`Networks.PUBLIC` / `Networks.TESTNET`).
 * @param {string} [params.contractId]       StrKey contract address that emitted the event, if known.
 * @param {number} [params.ledger]           Ledger sequence the event was emitted in.
 * @param {string} [params.transactionHash]  Hash of the transaction the event was emitted in.
 * @param {number} [params.operationIndex]   Index of the operation within that transaction.
 * @param {string} [params.eventPosition]    The source event's own id — for Soroban RPC, its
 *                                           `<19-char TOID>-<10-char event index>` string, which is the
 *                                           only place "event position within the operation" is exposed.
 * @returns {{ id: string, sufficient: true, derivation: "canonical" | "position-only" }
 *          | { id: null, sufficient: false, reason: string }}
 *
 * Time/space: O(1).
 */
export function deriveEventId({
  network,
  contractId,
  ledger,
  transactionHash,
  operationIndex,
  eventPosition,
} = {}) {
  if (!isNonEmptyString(eventPosition)) {
    return {
      id: null,
      sufficient: false,
      reason: "insufficiently identified event: missing event position (source event id)",
    };
  }

  const contract = isNonEmptyString(contractId) ? contractId : null;
  const net = isNonEmptyString(network) ? network : null;

  const fullyQualified =
    net !== null &&
    isPositiveInteger(ledger) &&
    isNonEmptyString(transactionHash) &&
    isNonNegativeInteger(operationIndex);

  if (fullyQualified) {
    return {
      id: hashTuple([
        ID_VERSION,
        "canonical",
        net,
        contract,
        ledger,
        transactionHash,
        operationIndex,
        eventPosition,
      ]),
      sufficient: true,
      derivation: "canonical",
    };
  }

  // Degraded path: the source event id is present and unique per event, but
  // the fuller position isn't (e.g. `src/lib/indexer/recovery.js`'s
  // Horizon-payment-derived events, which have a stable per-operation TOID
  // but no Soroban-style `operationIndex`). Still deterministic, still
  // exactly-once within one network.
  return {
    id: hashTuple([ID_VERSION, "position-only", net, contract, eventPosition]),
    sufficient: true,
    derivation: "position-only",
  };
}

/**
 * Derive an id straight from an indexer event object, mapping its various
 * field names onto `deriveEventId`. This is the only place that mapping
 * lives.
 *
 * Accepts both the parsed shape (`transactionHash`, `id`) and the raw Soroban
 * RPC shape (`txHash`, `id`), and the dead-letter shape (`eventId`).
 *
 * Time/space: O(1).
 */
export function deriveEventIdFromEvent(event = {}) {
  return deriveEventId({
    network: event.network,
    contractId: event.contractId,
    ledger: event.ledger,
    transactionHash: event.transactionHash ?? event.txHash,
    operationIndex: event.operationIndex,
    eventPosition: event.id ?? event.eventId,
  });
}

/**
 * Deterministic `_id` for a quarantine record (#630). An event that reaches
 * quarantine has, by definition, failed the check that makes an id
 * trustworthy — this key only needs to keep the same rejected event from
 * re-quarantining as a fresh document on every retry. It is a hash of the
 * source plus the raw event itself, so a replay of the byte-identical event
 * upserts the same row while two different unidentified events in one
 * transaction still get distinct rows. (Best-effort: it assumes the RPC emits
 * a stable JSON key order for a given event, which it does per server version;
 * a reordering at worst produces one extra inspection row, never a wrong
 * projection.)
 *
 * Time/space: O(s) in the raw event's serialized size `s` (one RPC page item,
 * bounded); O(1) extra space.
 */
export function computeQuarantineKey({ source, rawEvent } = {}) {
  const digest = createHash("sha256")
    .update(JSON.stringify({ source: source || null, rawEvent: rawEvent ?? null }))
    .digest("hex");
  return `quarantine:${digest}`;
}

// The pre-#630 dead-letter fallback shape: `${source}:unknown:${ledger}:${idOrRandom}`.
const LEGACY_FALLBACK_ID_PATTERN = /^[^:]+:unknown:/;

/**
 * @param {string} id
 * @returns {boolean} true if `id` was assigned by the old non-deterministic
 * `Math.random()` dead-letter fallback and therefore isn't a stable identity.
 */
export function isLegacyFallbackId(id) {
  return typeof id === "string" && LEGACY_FALLBACK_ID_PATTERN.test(id);
}

/**
 * @param {string} id
 * @returns {boolean} true if `id` is already in the current `evt_v1_` scheme.
 */
export function isCanonicalEventId(id) {
  return typeof id === "string" && id.startsWith(`${ID_PREFIX}_${ID_VERSION}_`);
}

/**
 * Decide what the id migration should do with one stored `sync_events` /
 * `dead_letter_events` row. Pure — the migration script is a thin loop over
 * this (see `scripts/migrations/migrate-indexer-event-ids.mjs`).
 *
 * @param {object} params
 * @param {string}  params.currentId   The row's existing `_id`.
 * @param {object}  [params.rawEvent]  The row's stored raw/parsed event.
 * @param {string}  [params.network]   Canonical network passphrase for the deployment.
 * @returns {{ status: "unchanged" | "rewrite" | "quarantine", canonicalId: string | null, reason: string }}
 *
 * Time/space: O(1).
 */
export function planEventIdRewrite({ currentId, rawEvent, network } = {}) {
  if (!rawEvent || typeof rawEvent !== "object") {
    return { status: "quarantine", canonicalId: null, reason: "row has no stored raw event to re-derive from" };
  }

  const derived = deriveEventIdFromEvent({ ...rawEvent, network: rawEvent.network ?? network });

  if (!derived.sufficient) {
    return { status: "quarantine", canonicalId: null, reason: derived.reason };
  }
  if (derived.id === currentId) {
    return { status: "unchanged", canonicalId: derived.id, reason: "already at canonical id" };
  }
  return {
    status: "rewrite",
    canonicalId: derived.id,
    reason: isLegacyFallbackId(currentId)
      ? "legacy Math.random() fallback id"
      : `pre-#630 id (${derived.derivation} derivation)`,
  };
}
