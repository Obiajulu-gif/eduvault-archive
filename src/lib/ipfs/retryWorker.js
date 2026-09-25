import { getDb } from '@/lib/mongodb';
import { pinata } from '@/lib/pinata';
import { auditLog } from '@/lib/api/audit';
import { normalizeStringList, sanitizeObject } from '@/lib/api/validation';

export async function processPendingPins() {
  try {
    const db = await getDb();
    const pendingCollection = db.collection('pending_pins');
    
    // Find up to 10 pending pins
    const pendingItems = await pendingCollection.find({ status: 'pending' }).limit(10).toArray();
    
    for (const item of pendingItems) {
      try {
        const results = {};

        // 1. Upload File
        if (item.fileData) {
          // BSON Binary type has a buffer property
          const buffer = item.fileData.buffer;
          const fileBlob = new Blob([buffer], { type: item.fileType });
          const file = new File([fileBlob], item.fileName || 'file', { type: item.fileType });
          const uploadedFile = await pinata.upload.public.file(file);
          results.fileUrl = await pinata.gateways.public.convert(uploadedFile.cid);
          results.storageKey = uploadedFile.cid;
        }

        // 2. Upload Thumbnail
        if (item.imageData) {
          const buffer = item.imageData.buffer;
          const imgBlob = new Blob([buffer], { type: item.imageType });
          const image = new File([imgBlob], item.imageName || 'thumbnail', { type: item.imageType });
          const fileThumb = await pinata.upload.public.file(image);
          results.imgUrl = await pinata.gateways.public.convert(fileThumb.cid);
        }

        // 3. Construct Metadata
        const otherFields = item.otherFields || {};
        const previewInputs = {
          learningOutcomes: otherFields.learningOutcomes,
          tableOfContents: otherFields.tableOfContents,
          sampleNotes: otherFields.sampleNotes,
        };
        const scalarFields = { ...otherFields };
        delete scalarFields.learningOutcomes;
        delete scalarFields.tableOfContents;
        delete scalarFields.sampleNotes;
        
        const sanitizedScalarFields = sanitizeObject(scalarFields, {
          title: 160,
          description: 5000,
          shortSummary: 280,
          usageRights: 1000,
          coverImageUrl: 2048,
          thumbnailUrl: 2048,
        });

        const metadataJSON = {
          name: sanitizedScalarFields.title || sanitizedScalarFields.name || "",
          description: sanitizedScalarFields.description || "",
          image: results.imgUrl || null,
          properties: {
            ...sanitizedScalarFields,
            coverImageUrl: results.imgUrl || sanitizedScalarFields.coverImageUrl || null,
            thumbnailUrl: results.imgUrl || sanitizedScalarFields.thumbnailUrl || null,
            learningOutcomes: normalizeStringList(previewInputs.learningOutcomes, {
              maxItems: 8,
              maxLength: 180,
            }),
            tableOfContents: normalizeStringList(previewInputs.tableOfContents, {
              maxItems: 16,
              maxLength: 180,
            }),
            sampleNotes: normalizeStringList(previewInputs.sampleNotes, {
              maxItems: 6,
              maxLength: 280,
            }),
            storageKey: results.storageKey,
            fileUrl: results.fileUrl,
            timestamp: new Date().toISOString(),
          },
          ...sanitizedScalarFields,
          coverImageUrl: results.imgUrl || sanitizedScalarFields.coverImageUrl || null,
          thumbnailUrl: results.imgUrl || sanitizedScalarFields.thumbnailUrl || null,
          learningOutcomes: normalizeStringList(previewInputs.learningOutcomes, {
            maxItems: 8,
            maxLength: 180,
          }),
          tableOfContents: normalizeStringList(previewInputs.tableOfContents, {
            maxItems: 16,
            maxLength: 180,
          }),
          sampleNotes: normalizeStringList(previewInputs.sampleNotes, {
            maxItems: 6,
            maxLength: 280,
          }),
          storageKey: results.storageKey,
          fileUrl: results.fileUrl,
          image: results.imgUrl || null,
          timestamp: new Date().toISOString(),
        };

        const uploadedJson = await pinata.upload.public.json(metadataJSON);
        results.metadataUrl = await pinata.gateways.public.convert(uploadedJson.cid);

        // Update DB
        await pendingCollection.updateOne(
          { _id: item._id },
          { 
            $set: { 
              status: 'completed', 
              completedAt: new Date(), 
              results 
            } 
          }
        );

        auditLog({
          event: 'retry_upload_success',
          route: 'worker',
          method: 'CRON',
          status: 200,
          reason: `Uploaded pending pin ${item._id}`,
        });

      } catch (err) {
        console.error(`Failed to process pending pin ${item._id}`, err);
        auditLog({
          event: 'retry_upload_failed',
          route: 'worker',
          method: 'CRON',
          status: 500,
          reason: err.message,
        });
      }
    }
  } catch (err) {
    console.error('Failed to run processPendingPins worker', err);
  }
}
