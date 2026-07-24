import { MongoClient } from "mongodb";
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

const uri = process.env.MONGODB_URI;

async function backfillPurchases() {
  if (!uri) {
    console.error("MONGODB_URI is not set");
    process.exit(1);
  }

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || "eduvault");

    const purchasesCollection = db.collection("purchases");
    const entitlementCache = db.collection("entitlement_cache");
    const outboxCollection = db.collection("outbox");

    console.log("Looking for confirmed purchases...");
    const purchases = await purchasesCollection.find({ status: "confirmed" }).toArray();

    console.log(`Found ${purchases.length} confirmed purchases. checking entitlements...`);

    let backfilled = 0;

    for (const purchase of purchases) {
      const { materialId, buyerAddress, transactionHash } = purchase;
      const normalised = buyerAddress.toLowerCase();

      const existingEntitlement = await entitlementCache.findOne({
        materialId,
        buyerAddress: normalised,
      });

      if (!existingEntitlement) {
        console.log(`Backfilling entitlement for purchase ${purchase._id}`);
        await entitlementCache.updateOne(
          { materialId, buyerAddress: normalised },
          {
            $set: {
              materialId,
              buyerAddress: normalised,
              active: true,
              source: "purchase-api-backfill",
              purchaseId: String(purchase._id),
              transactionHash: transactionHash || null,
              amount: purchase.amount || null,
              asset: purchase.asset || null,
              updatedAt: new Date(),
            },
            $setOnInsert: {
              createdAt: new Date(),
            },
          },
          { upsert: true }
        );

        // Optionally, if we missed webhook delivery during crash, we can add it to the outbox.
        // Uncomment the following lines if we want to also trigger webhook events on backfill.
        /*
        await outboxCollection.insertOne({
          type: "send_purchase_webhook",
          payload: {
            materialId,
            buyerAddress,
            amount: purchase.amount,
            asset: purchase.asset,
            transactionHash,
          },
          idempotencyKey: `webhook_backfill_${purchase._id}_${transactionHash || 'nohash'}`,
          status: "pending",
          lockedUntil: null,
          retries: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        */
        
        backfilled++;
      }
    }

    console.log(`Backfill complete. Backfilled ${backfilled} entitlements.`);
  } catch (error) {
    console.error("Error backfilling purchases:", error);
  } finally {
    await client.close();
  }
}

backfillPurchases().catch(console.error);
