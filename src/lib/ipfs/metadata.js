/**
 * Builds the standard listing metadata JSON for a material and pins it to IPFS.
 * Pinned alongside the raw file/thumbnail so buyers and indexers can verify
 * listing details directly from IPFS rather than trusting the database alone.
 */
import { pinata } from "@/lib/pinata";
import { normalizeStringList, sanitizeObject } from "@/lib/api/validation";

const SCALAR_FIELD_LIMITS = {
  title: 160,
  description: 5000,
  shortSummary: 280,
  usageRights: 1000,
  coverImageUrl: 2048,
  thumbnailUrl: 2048,
  category: 80,
  subject: 80,
  level: 40,
  visibility: 40,
  fileType: 40,
};

/**
 * Builds a standard NFT-style JSON metadata object for a material listing.
 *
 * @param {object} material - Material document from MongoDB.
 * @returns {object} Standard metadata JSON ready to be pinned to IPFS.
 */
export function buildMaterialMetadata(material) {
  const scalarFields = sanitizeObject(
    {
      title: material.title,
      description: material.description,
      shortSummary: material.shortSummary,
      usageRights: material.usageRights,
      coverImageUrl: material.coverImageUrl || material.image,
      thumbnailUrl: material.thumbnailUrl || material.coverImageUrl || material.image,
      category: material.category,
      subject: material.subject,
      level: material.level,
      visibility: material.visibility,
      fileType: material.fileType,
    },
    SCALAR_FIELD_LIMITS
  );

  const image = scalarFields.coverImageUrl || scalarFields.thumbnailUrl || null;
  const learningOutcomes = normalizeStringList(material.learningOutcomes, { maxItems: 8, maxLength: 180 });
  const tableOfContents = normalizeStringList(material.tableOfContents, { maxItems: 16, maxLength: 180 });
  const sampleNotes = normalizeStringList(material.sampleNotes, { maxItems: 6, maxLength: 280 });

  return {
    name: scalarFields.title || "Untitled material",
    description: scalarFields.description || "",
    image,
    external_url: material.materialId ? `${process.env.NEXT_PUBLIC_APP_URL || ""}/marketplace/${material.materialId}` : undefined,
    properties: {
      ...scalarFields,
      learningOutcomes,
      tableOfContents,
      sampleNotes,
      price: material.price ?? null,
      currency: material.currency || "XLM",
      storageKey: material.storageKey || material.ipfsCid || material.cid || null,
      fileUrl: material.fileUrl || null,
      creator: material.userAddress || material.ownerAddress || null,
      version: material.version || 1,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Generates the standard metadata JSON for a material and pins it to IPFS.
 *
 * @param {object} material - Material document (should include materialId).
 * @returns {Promise<{ metadataCid: string, metadataUrl: string, metadata: object }>}
 */
export async function pinMaterialMetadata(material) {
  const metadata = buildMaterialMetadata(material);
  const uploaded = await pinata.upload.public.json(metadata);
  const metadataUrl = await pinata.gateways.public.convert(uploaded.cid);

  return {
    metadataCid: uploaded.cid,
    metadataUrl,
    metadata,
  };
}
