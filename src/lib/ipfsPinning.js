import { pinata } from "@/lib/pinata";
import { getDb } from "@/lib/mongodb";
import { COLLECTIONS, applyTimestamps } from "@/lib/backend/schemaContracts";

const PINATA_API_BASE_URL = "https://api.pinata.cloud";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_GC_AGE_MS = 24 * 60 * 60 * 1000;
const REGEX_CHARS = /[.*+?^${}()|[\]\\]/g;

export function extractCid(value) {
  if (!value || typeof value !== "string") return "";

  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("ipfs://")) {
    return trimmed.slice("ipfs://".length).split(/[/?#]/)[0];
  }

  const ipfsIndex = trimmed.indexOf("/ipfs/");
  if (ipfsIndex >= 0) {
    return trimmed.slice(ipfsIndex + "/ipfs/".length).split(/[/?#]/)[0];
  }

  return trimmed.split(/[/?#]/)[0];
}

function getRetryDelay(attempt, initialDelayMs) {
  return initialDelayMs * 2 ** Math.max(0, attempt - 1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryPinataCall(operation, options = {}) {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
    shouldRetry = () => true,
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries || !shouldRetry(error)) break;
      await sleep(getRetryDelay(attempt, initialDelayMs));
    }
  }

  throw lastError;
}

export async function uploadFileToIpfs(file, options = {}) {
  return retryPinataCall(() => pinata.upload.public.file(file), options);
}

export async function uploadJsonToIpfs(json, options = {}) {
  return retryPinataCall(() => pinata.upload.public.json(json), options);
}

export async function convertCidToGatewayUrl(cid, options = {}) {
  return retryPinataCall(() => pinata.gateways.public.convert(cid), options);
}

async function pinataFetch(path, options = {}) {
  const { okStatuses = [], ...fetchOptions } = options;

  if (!process.env.PINATA_JWT) {
    throw new Error("PINATA_JWT is not set in environment variables");
  }

  const response = await fetch(`${PINATA_API_BASE_URL}${path}`, {
    ...fetchOptions,
    headers: {
      Authorization: `Bearer ${process.env.PINATA_JWT}`,
      ...(fetchOptions.headers || {}),
    },
  });

  if (okStatuses.includes(response.status)) return null;

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Pinata API ${response.status}: ${detail || response.statusText}`);
  }

  if (response.status === 204) return null;
  return response.json().catch(() => null);
}

export async function getPinStatus(cid, options = {}) {
  const cleanCid = extractCid(cid);
  if (!cleanCid) return { cid: "", pinned: false, status: "invalid" };

  const data = await retryPinataCall(
    () =>
      pinataFetch(
        `/data/pinList?hashContains=${encodeURIComponent(cleanCid)}&status=pinned`
      ),
    options
  );
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const activePin = rows.find((row) => row.ipfs_pin_hash === cleanCid);

  return {
    cid: cleanCid,
    pinned: Boolean(activePin),
    status: activePin ? "pinned" : "missing",
    pin: activePin || null,
  };
}

export async function unpinCid(cid, options = {}) {
  const cleanCid = extractCid(cid);
  if (!cleanCid) return { cid: "", unpinned: false };

  await retryPinataCall(
    () =>
      pinataFetch(`/pinning/unpin/${encodeURIComponent(cleanCid)}`, {
        method: "DELETE",
        okStatuses: [404],
      }),
    options
  );

  return { cid: cleanCid, unpinned: true };
}

export async function recordIpfsUpload({ cid, kind, userAddress = null, metadata = {} }) {
  const cleanCid = extractCid(cid);
  if (!cleanCid) return null;

  const db = await getDb();
  const now = new Date();
  const upload = applyTimestamps(
    {
      cid: cleanCid,
      kind,
      userAddress,
      status: "pending_registration",
      metadata,
      createdAt: now,
      updatedAt: now,
    },
    now
  );

  await db.collection(COLLECTIONS.ipfsUploads).updateOne(
    { cid: cleanCid },
    {
      $setOnInsert: upload,
      $set: {
        kind,
        userAddress,
        lastSeenAt: now,
        updatedAt: now,
      },
    },
    { upsert: true }
  );

  return upload;
}

export async function markUploadsRegistered({
  cids,
  materialId = null,
  txHash = null,
  chainRegistered = Boolean(txHash),
}) {
  const cleanCids = [...new Set((cids || []).map(extractCid).filter(Boolean))];
  if (cleanCids.length === 0) return { matchedCount: 0, modifiedCount: 0 };

  const db = await getDb();
  const set = {
    status: chainRegistered ? "registered_on_chain" : "material_created",
    materialId,
    updatedAt: new Date(),
  };

  if (txHash) set.txHash = txHash;
  if (chainRegistered) set.registeredAt = new Date();

  const result = await db.collection(COLLECTIONS.ipfsUploads).updateMany(
    { cid: { $in: cleanCids } },
    { $set: set }
  );

  return {
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
  };
}

function materialCidSet(material) {
  return new Set(
    [
      material.storageKey,
      material.fileUrl,
      material.metadataUrl,
      material.metadata,
      material.thumbnailUrl,
      material.image,
    ]
      .map(extractCid)
      .filter(Boolean)
  );
}

function hasChainRegistration(material) {
  return Boolean(
    material.tokenId ||
      material.mintTxHash ||
      material.chainTxHash ||
      material.chainContractId ||
      material.mintStatus === "confirmed" ||
      material.syncStatus === "confirmed"
  );
}

export async function reconcileIpfsPins(options = {}) {
  const {
    limit = 100,
    gcOlderThanMs = DEFAULT_GC_AGE_MS,
    dryRun = false,
    retryOptions = {},
  } = options;
  const db = await getDb();
  const materialsCollection = db.collection(COLLECTIONS.materials);
  const uploadsCollection = db.collection(COLLECTIONS.ipfsUploads);
  const now = new Date();

  const materials = await materialsCollection
    .find({
      $or: [
        { storageKey: { $exists: true, $ne: "" } },
        { fileUrl: { $exists: true, $ne: "" } },
      ],
    })
    .limit(limit)
    .toArray();
  const materialCids = new Set();
  const audit = [];

  for (const material of materials) {
    const cids = [...materialCidSet(material)];
    cids.forEach((cid) => materialCids.add(cid));

    const pinResults = [];
    for (const cid of cids) {
      const status = await getPinStatus(cid, retryOptions);
      pinResults.push(status);
    }

    const missing = pinResults.filter((result) => !result.pinned).map((result) => result.cid);
    audit.push({ materialId: material._id, checked: cids, missing });

    if (!dryRun) {
      await materialsCollection.updateOne(
        { _id: material._id },
        {
          $set: {
            ipfsPinAudit: {
              checkedAt: now,
              status: missing.length === 0 ? "healthy" : "missing_pins",
              missing,
            },
            updatedAt: now,
          },
        }
      );

      await markUploadsRegistered({
        cids,
        materialId: material._id,
        txHash: material.mintTxHash || material.chainTxHash || null,
        chainRegistered: hasChainRegistration(material),
      });
    }
  }

  const cutoff = new Date(now.getTime() - gcOlderThanMs);
  const staleUploads = await uploadsCollection
    .find({
      status: { $in: ["pending_registration", "material_created"] },
      createdAt: { $lt: cutoff },
    })
    .limit(limit)
    .toArray();
  const garbageCollected = [];

  for (const upload of staleUploads) {
    if (materialCids.has(upload.cid)) continue;
    const cidPattern = upload.cid.replace(REGEX_CHARS, "\\$&");

    const referenced = await materialsCollection.findOne({
      $or: [
        { storageKey: upload.cid },
        { fileUrl: { $regex: cidPattern } },
        { metadataUrl: { $regex: cidPattern } },
        { thumbnailUrl: { $regex: cidPattern } },
      ],
    });
    if (referenced) continue;

    if (!dryRun) {
      await unpinCid(upload.cid, retryOptions);
      await uploadsCollection.updateOne(
        { _id: upload._id },
        {
          $set: {
            status: "unpinned_unreferenced",
            unpinnedAt: now,
            updatedAt: now,
          },
        }
      );
    }

    garbageCollected.push({ cid: upload.cid, kind: upload.kind });
  }

  return {
    checkedMaterials: audit.length,
    missingPins: audit.filter((entry) => entry.missing.length > 0),
    garbageCollected,
    dryRun,
  };
}
