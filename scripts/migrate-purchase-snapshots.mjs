#!/usr/bin/env node
import { getDb } from '../src/lib/mongodb.js';

const db = await getDb();
const purchases = db.collection('purchases');
const materials = db.collection('materials');

const cursor = purchases.find({
  $or: [{ purchaseSnapshot: { $exists: false } }, { purchaseSnapshot: null }],
});

let updated = 0;
for await (const purchase of cursor) {
  const material = await materials.findOne({ _id: purchase.materialId });
  if (!material) continue;

  const purchaseSnapshot = {
    metadataHash: material.metadataHash || material.contentManifestHash || null,
    rightsHash: material.rightsHash || null,
    saleTermsVersion: material.saleTermsVersion || 1,
    metadataUri: material.metadataUrl || material.metadataCid || null,
    migratedAt: new Date().toISOString(),
  };

  await purchases.updateOne(
    { _id: purchase._id },
    { $set: { purchaseSnapshot, updatedAt: new Date() } }
  );
  updated += 1;
}

console.log(`Backfilled purchase snapshots for ${updated} purchase records.`);
