#!/usr/bin/env node
/**
 * Monthly creator payout statement generator (#293).
 *
 * Consolidates the previous calendar month's completed sales and payouts
 * for every creator, renders a PDF earnings statement (sales counts,
 * currency rates, total earnings, payout transaction hashes), uploads it to
 * a private S3-compatible bucket, and emails each creator a time-limited
 * access link.
 *
 * Intended to run once a month via cron, the same "external scheduler
 * invokes a one-shot script" pattern already used by every other script in
 * this directory (see scripts/weekly-admin-stats.mjs, scripts/backup-cron.txt):
 *
 *   0 6 1 * *  node scripts/monthly-statements.mjs
 *
 * Usage:
 *   node scripts/monthly-statements.mjs
 *   DRY_RUN=true node scripts/monthly-statements.mjs
 *   STATEMENT_MONTH=2026-07 node scripts/monthly-statements.mjs   # backfill/reissue
 *   FORCE_REGENERATE=true STATEMENT_MONTH=2026-07 node scripts/monthly-statements.mjs
 *
 * Required env vars:
 *   MONGODB_URI              — MongoDB connection string
 *   EMAIL_USER / EMAIL_PASS  — SMTP credentials (or SMTP_HOST / SMTP_USER / SMTP_PASS)
 *
 * Optional env vars:
 *   MONGODB_DB                    — database name (default: "eduvault")
 *   STATEMENT_MONTH                — "YYYY-MM" to process instead of last month
 *   DRY_RUN                        — "true": generate PDFs and log the summary,
 *                                     skip S3 upload, email, and the idempotency record
 *   FORCE_REGENERATE                — "true": regenerate even if a statement already
 *                                     exists for a creator/month
 *   STATEMENTS_S3_BUCKET            — destination bucket; upload is skipped (PDFs kept
 *                                     locally only) if unset
 *   STATEMENTS_S3_REGION            — AWS region (default: us-east-1)
 *   STATEMENTS_S3_ENDPOINT          — custom S3 endpoint (R2/MinIO)
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY — S3 credentials
 *   STATEMENTS_LINK_EXPIRES_IN_DAYS — presigned link lifetime (default: 30)
 *   STATEMENTS_LOCAL_DIR            — local fallback output dir when no bucket is
 *                                     configured (default: an OS temp dir)
 *   EMAIL_FROM                      — sender address (defaults to EMAIL_USER)
 *   NEXT_PUBLIC_STELLAR_NETWORK     — "PUBLIC" or "TESTNET" (default: TESTNET)
 *   NEXT_PUBLIC_HORIZON_URL         — Horizon URL override
 *   NEXT_PUBLIC_USDC_ISSUER         — USDC issuer override
 *   NEXT_PUBLIC_EXPLORER_URL        — Stellar Expert base URL override (for PDF tx links)
 *   BATCH_SIZE                      — Mongo cursor batch size (default: 200)
 */

import { config } from "dotenv";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { MongoClient } from "mongodb";
import { Horizon, Asset } from "@stellar/stellar-sdk";
import { generatePayoutStatementPdf } from "../src/lib/analytics/pdfGenerator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env.local"), override: false, quiet: true });
config({ path: resolve(__dirname, "../.env"), override: false, quiet: true });

// ── Config ────────────────────────────────────────────────────────────────────

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "eduvault";
const DRY_RUN = process.env.DRY_RUN === "true";
const FORCE_REGENERATE = process.env.FORCE_REGENERATE === "true";
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? "200");

const S3_BUCKET = process.env.STATEMENTS_S3_BUCKET || null;
const S3_REGION = process.env.STATEMENTS_S3_REGION || "us-east-1";
const S3_ENDPOINT = process.env.STATEMENTS_S3_ENDPOINT || null;
const LINK_EXPIRES_IN_DAYS = Number(process.env.STATEMENTS_LINK_EXPIRES_IN_DAYS ?? "30");

const IS_MAINNET = (process.env.NEXT_PUBLIC_STELLAR_NETWORK || "TESTNET") === "PUBLIC";
const HORIZON_URL =
  process.env.NEXT_PUBLIC_HORIZON_URL ||
  (IS_MAINNET ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org");
// Source of truth: Circle's own USDC issuer directory
// (developers.circle.com/stablecoins/usdc-contract-addresses), cross-checked
// against a Stellar block explorer and StrKey-checksum-validated with
// `@stellar/stellar-sdk`'s `StrKey.isValidEd25519PublicKey()`.
//
// NOT copied from src/lib/stellar/horizonClient.js's KNOWN_USDC_ISSUERS
// (this file can't import that module — see the file header) — and it's
// worth being explicit about why: that constant's testnet AND mainnet
// values both FAIL StrKey checksum validation (confirmed with the same
// SDK call above). They're well-formed-looking but not valid Stellar
// addresses, so any code path that ever falls back to them — including
// checkBuyerTrustline() and refundService.js's on-chain refund payouts,
// via resolveAssetIssuer() — would fail against a real Horizon instance
// unless NEXT_PUBLIC_USDC_ISSUER is set to override it. That's a real,
// pre-existing bug, unrelated to #293 and out of this issue's scope to
// fix; flagged in implementation.md rather than silently carried forward
// into this new script.
const KNOWN_USDC_ISSUERS = {
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  mainnet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};
const USDC_ISSUER =
  process.env.NEXT_PUBLIC_USDC_ISSUER || KNOWN_USDC_ISSUERS[IS_MAINNET ? "mainnet" : "testnet"];
const EXPLORER_URL =
  process.env.NEXT_PUBLIC_EXPLORER_URL ||
  (IS_MAINNET ? "https://stellar.expert/explorer/public" : "https://stellar.expert/explorer/testnet");

// The app's own default accepted payment asset (src/lib/config/chain.js
// ACCEPTED_ASSET) — used only as the fallback when a purchase/payout
// document has no asset/currency field recorded at all.
const DEFAULT_ASSET_CODE = "USDC";

const COMPLETED_PURCHASE_STATUSES = ["confirmed", "settled", "completed"];
const COMPLETED_PAYOUT_STATUSES = ["completed", "paid", "settled"];

function log(level, message, extra = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...extra }));
}

if (!MONGODB_URI) {
  log("error", "MONGODB_URI is not set. Aborting.");
  process.exit(1);
}
if (!process.env.EMAIL_USER && !process.env.SMTP_USER) {
  log("error", "No email credentials found (set EMAIL_USER/EMAIL_PASS or SMTP_USER/SMTP_PASS). Aborting.");
  process.exit(1);
}
if (!Number.isFinite(BATCH_SIZE) || BATCH_SIZE <= 0) {
  log("error", `Invalid BATCH_SIZE: "${process.env.BATCH_SIZE}". Must be a positive number.`);
  process.exit(1);
}

// ── Month resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the [start, end) UTC month boundary to consolidate. Defaults to
 * last calendar month; STATEMENT_MONTH=YYYY-MM overrides for backfills.
 */
function resolveMonthRange() {
  const override = process.env.STATEMENT_MONTH;
  let year, monthIndex; // monthIndex: 0-based

  if (override) {
    const match = /^(\d{4})-(\d{2})$/.exec(override.trim());
    if (!match) {
      log("error", `Invalid STATEMENT_MONTH: "${override}". Expected "YYYY-MM".`);
      process.exit(1);
    }
    year = Number(match[1]);
    monthIndex = Number(match[2]) - 1;
  } else {
    const now = new Date();
    year = now.getUTCFullYear();
    monthIndex = now.getUTCMonth() - 1;
    if (monthIndex < 0) {
      monthIndex = 11;
      year -= 1;
    }
  }

  const from = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
  const to = new Date(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0));
  const label = from.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const monthKey = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
  return { from, to, label, monthKey };
}

// ── Stellar: XLM/USD rate for the statement period ─────────────────────────────

/**
 * Volume-weighted average XLM price in USDC across the statement month,
 * sourced from Stellar's own DEX via Horizon's trade_aggregations endpoint
 * (https://developers.stellar.org/docs/data/apis/horizon/api-reference/list-trade-aggregations).
 * USDC is a USD-pegged stablecoin, so this doubles as an XLM/USD rate.
 *
 * Verified against the pinned `@stellar/stellar-sdk@^13.3.0` package source
 * (dist/lib/horizon/trade_aggregation_call_builder.d.ts): valid `resolution`
 * values are fixed millisecond buckets — 60000, 300000, 900000, 3600000,
 * 86400000 (1 day, used here), 604800000 — and each record's `avg` field is
 * a decimal string, not a fraction.
 *
 * Returns null (never a fabricated number) if Horizon has no trade data for
 * the window — realistic on testnet or for a low-liquidity pair.
 *
 * Time: one Horizon call (O(1) round trip); O(D) records, D = days with at
 * least one trade in the month (<= 31), comfortably within one page.
 */
async function fetchXlmUsdRate(horizonServer, from, to) {
  const ONE_DAY_MS = 86400000;
  try {
    const page = await horizonServer
      .tradeAggregation(Asset.native(), new Asset("USDC", USDC_ISSUER), from.getTime(), to.getTime(), ONE_DAY_MS, 0)
      .limit(200)
      .call();

    const records = page.records || [];
    let volumeWeightedSum = 0;
    let totalVolume = 0;
    for (const r of records) {
      const avg = Number(r.avg);
      const volume = Number(r.base_volume);
      if (!Number.isFinite(avg)) continue;
      if (Number.isFinite(volume) && volume > 0) {
        volumeWeightedSum += avg * volume;
        totalVolume += volume;
      }
    }
    if (totalVolume > 0) {
      return { rateToUsd: volumeWeightedSum / totalVolume, recordCount: records.length };
    }
    // No usable volume figures — fall back to a simple mean of daily averages.
    const avgs = records.map((r) => Number(r.avg)).filter(Number.isFinite);
    if (avgs.length > 0) {
      return { rateToUsd: avgs.reduce((a, b) => a + b, 0) / avgs.length, recordCount: avgs.length };
    }
    return { rateToUsd: null, recordCount: 0 };
  } catch (err) {
    log("warn", "XLM/USDC rate lookup failed — reporting XLM amounts without a USD equivalent", {
      error: err.message,
    });
    return { rateToUsd: null, recordCount: 0 };
  }
}

function buildCurrencyRates(xlmRate) {
  return [
    { currency: "USDC", rateToUsd: 1, source: "USD-pegged stablecoin (fixed 1:1)" },
    {
      currency: "XLM",
      rateToUsd: xlmRate.rateToUsd,
      source:
        xlmRate.rateToUsd === null
          ? "unavailable — no Stellar DEX trades found for this period"
          : `Stellar DEX volume-weighted average, ${xlmRate.recordCount} daily record(s)`,
    },
  ];
}

function rateFor(currencyRates, currency) {
  if (currency === "USDC") return 1;
  const entry = currencyRates.find((r) => r.currency === currency);
  return entry ? entry.rateToUsd : null;
}

// ── Mongo: consolidate the month's sales and payouts per creator ──────────────

function buildMaterialKeys(material) {
  return [material?._id, material?.materialId].filter(Boolean).map((v) => String(v));
}

/**
 * Time:  O(M) to load the material->creator/title map (a full scan is
 *        unavoidable — we don't know which creators are relevant until every
 *        purchase's materialId has been resolved), then O(S) + O(P) to
 *        stream sales and payouts once each via a cursor, grouping into
 *        per-creator buckets with O(1) average map lookups.
 * Space: O(M) for the material map (irreducible, see above), O(1) additional
 *        beyond that per streamed sale/payout — cursors are iterated with
 *        `for await`, never buffered with `.toArray()`. Result size is
 *        O(S + P), the number of qualifying rows, which is what actually
 *        ends up in the PDFs.
 */
async function consolidateMonth(db, from, to) {
  const materials = db.collection("materials");
  const purchases = db.collection("purchases");
  const payouts = db.collection("payouts");

  const materialDocs = await materials
    .find({}, { projection: { _id: 1, materialId: 1, userAddress: 1, title: 1 } })
    .toArray();

  const materialToCreator = new Map();
  const materialToTitle = new Map();
  for (const material of materialDocs) {
    const title = material.title || "Untitled material";
    for (const key of buildMaterialKeys(material)) {
      materialToCreator.set(key, material.userAddress);
      materialToTitle.set(key, title);
    }
  }

  /** @type {Map<string, { sales: object[], grossByCurrency: Record<string, number> }>} */
  const byCreator = new Map();
  function creatorBucket(creatorAddress) {
    if (!byCreator.has(creatorAddress)) {
      byCreator.set(creatorAddress, {
        sales: [],
        payouts: [],
        grossByCurrency: {},
        paidByCurrency: {},
      });
    }
    return byCreator.get(creatorAddress);
  }

  const purchaseCursor = purchases
    .find(
      { status: { $in: COMPLETED_PURCHASE_STATUSES }, purchasedAt: { $gte: from, $lt: to } },
      { projection: { materialId: 1, buyerAddress: 1, amount: 1, asset: 1, transactionHash: 1, purchasedAt: 1 } },
    )
    .batchSize(BATCH_SIZE);

  let salesScanned = 0;
  for await (const purchase of purchaseCursor) {
    const creatorAddress = materialToCreator.get(String(purchase.materialId));
    if (!creatorAddress) continue; // material deleted/unowned — nothing to attribute this to
    salesScanned++;
    const currency = purchase.asset || DEFAULT_ASSET_CODE;
    const amount = Number(purchase.amount) || 0;
    const bucket = creatorBucket(creatorAddress);
    bucket.sales.push({
      date: purchase.purchasedAt,
      materialTitle: materialToTitle.get(String(purchase.materialId)) || "Untitled material",
      buyerAddress: purchase.buyerAddress,
      amount,
      currency,
      transactionHash: purchase.transactionHash || null,
    });
    bucket.grossByCurrency[currency] = (bucket.grossByCurrency[currency] || 0) + amount;
  }

  const payoutCursor = payouts
    .find({ createdAt: { $gte: from, $lt: to } })
    .batchSize(BATCH_SIZE);

  let payoutsScanned = 0;
  for await (const payout of payoutCursor) {
    const creatorAddress = payout.creatorAddress;
    if (!creatorAddress) continue;
    payoutsScanned++;
    // No writer for the `payouts` collection exists anywhere in this
    // codebase as of #293 (confirmed by search) — currency and tx-hash
    // field names are therefore inferred from the two existing read paths
    // (creator/payouts/route.js, creator/analytics/export/route.js), which
    // agree on creatorAddress/amount/status/createdAt but not on a
    // confirmed currency or tx-hash field name. Read defensively; never
    // fabricate a value that isn't present.
    const currency = payout.currency || payout.asset || DEFAULT_ASSET_CODE;
    const amount = Number(payout.amount) || 0;
    const status = payout.status || "unknown";
    const transactionHash = payout.transactionHash || payout.txHash || payout.chainTxHash || null;
    const bucket = creatorBucket(creatorAddress);
    bucket.payouts.push({ date: payout.createdAt, amount, currency, status, transactionHash });
    if (COMPLETED_PAYOUT_STATUSES.includes(status)) {
      bucket.paidByCurrency[currency] = (bucket.paidByCurrency[currency] || 0) + amount;
    }
  }

  return { byCreator, salesScanned, payoutsScanned, materialCount: materialDocs.length };
}

// ── S3 upload + presigned link ─────────────────────────────────────────────────

async function loadS3Clients() {
  try {
    const [{ S3Client, PutObjectCommand, GetObjectCommand }, { getSignedUrl }] = await Promise.all([
      import("@aws-sdk/client-s3"),
      import("@aws-sdk/s3-request-presigner"),
    ]);
    return { S3Client, PutObjectCommand, GetObjectCommand, getSignedUrl };
  } catch {
    return null;
  }
}

function buildS3Client(S3Client) {
  const clientConfig = {
    region: S3_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  };
  if (S3_ENDPOINT) {
    clientConfig.endpoint = S3_ENDPOINT;
    clientConfig.forcePathStyle = true;
  }
  return new S3Client(clientConfig);
}

/**
 * Upload the PDF to the configured private bucket and return a time-limited
 * presigned GET URL. Verified against the real `@aws-sdk/s3-request-presigner`
 * package: `getSignedUrl(client, command, { expiresIn }): Promise<string>`,
 * `expiresIn` in seconds.
 */
async function uploadStatement({ s3, creatorAddress, monthKey, pdfBuffer }) {
  const key = `statements/${creatorAddress}/${monthKey}.pdf`;
  await s3.client.send(
    new s3.PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: pdfBuffer,
      ContentType: "application/pdf",
      Metadata: { source: "eduvault-monthly-statements", creatorAddress, month: monthKey },
    }),
  );
  const url = await s3.getSignedUrl(
    s3.client,
    new s3.GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
    { expiresIn: LINK_EXPIRES_IN_DAYS * 24 * 60 * 60 },
  );
  return { key, url };
}

// ── Email ────────────────────────────────────────────────────────────────────

function buildMailTransport(nodemailer) {
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = Number(process.env.SMTP_PORT || 0);
  const smtpUser = process.env.SMTP_USER || process.env.EMAIL_USER;
  const smtpPass = process.env.SMTP_PASS || process.env.EMAIL_PASS;

  if (smtpHost) {
    const port = smtpPort || 587;
    return nodemailer.createTransport({ host: smtpHost, port, secure: port === 465, auth: { user: smtpUser, pass: smtpPass } });
  }
  return nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: smtpUser, pass: smtpPass } });
}

function buildStatementEmail({ creatorName, periodLabel, accessUrl, expiresInDays }) {
  const subject = `Your EduVault payout statement — ${periodLabel}`;
  const text = [
    `Hi ${creatorName || "there"},`,
    "",
    `Your EduVault payout statement for ${periodLabel} is ready.`,
    "",
    accessUrl
      ? `Download it here (link expires in ${expiresInDays} days): ${accessUrl}`
      : "It is attached to this email as a PDF.",
    "",
    "This statement is generated automatically and does not constitute tax or legal advice.",
    "",
    "— EduVault",
  ].join("\n");
  return { subject, text };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const { from, to, label, monthKey } = resolveMonthRange();
  log("info", `Starting monthly statement generation${DRY_RUN ? " (DRY_RUN)" : ""}`, { month: monthKey, label });

  const nodemailer = (await import("nodemailer")).default;
  // Built once and reused for every creator's sendMail — nodemailer
  // transports are meant to be pooled across sends, not reconnected per email.
  const mailTransport = buildMailTransport(nodemailer);
  const horizonServer = new Horizon.Server(HORIZON_URL, { allowHttp: HORIZON_URL.startsWith("http://") });
  const s3Deps = S3_BUCKET ? await loadS3Clients() : null;
  if (S3_BUCKET && !s3Deps) {
    log(
      "warn",
      "STATEMENTS_S3_BUCKET is set but @aws-sdk/client-s3 / @aws-sdk/s3-request-presigner are not installed — statements will be saved locally only, no access links will be emailed.",
    );
  }
  const s3 =
    s3Deps && S3_BUCKET
      ? {
          client: buildS3Client(s3Deps.S3Client),
          PutObjectCommand: s3Deps.PutObjectCommand,
          GetObjectCommand: s3Deps.GetObjectCommand,
          getSignedUrl: s3Deps.getSignedUrl,
        }
      : null;

  const client = new MongoClient(MONGODB_URI);
  const summary = { creatorsWithActivity: 0, generated: 0, uploaded: 0, emailed: 0, skippedExisting: 0, failed: 0 };

  try {
    await client.connect();
    const db = client.db(MONGODB_DB);

    log("info", "Computing XLM/USD rate for the period from Stellar DEX trade data...");
    const xlmRate = await fetchXlmUsdRate(horizonServer, from, to);
    const currencyRates = buildCurrencyRates(xlmRate);
    log("info", "Currency rates resolved", { currencyRates });

    log("info", "Consolidating sales and payouts for the period...");
    const { byCreator, salesScanned, payoutsScanned, materialCount } = await consolidateMonth(db, from, to);
    summary.creatorsWithActivity = byCreator.size;
    log("info", "Consolidation complete", {
      materialsScanned: materialCount,
      salesScanned,
      payoutsScanned,
      creatorsWithActivity: byCreator.size,
    });

    if (byCreator.size === 0) {
      log("info", "No creator activity for this period. Nothing to do.");
      return;
    }

    const creatorAddresses = [...byCreator.keys()];
    const users = db.collection("users");
    const userDocs = await users
      .find(
        { walletAddressLower: { $in: creatorAddresses.map((a) => String(a).toLowerCase()) } },
        { projection: { walletAddress: 1, walletAddressLower: 1, email: 1, fullName: 1, displayName: 1, preferredPayoutCurrency: 1 } },
      )
      .toArray();
    const userByAddress = new Map(userDocs.map((u) => [String(u.walletAddress || u.walletAddressLower).toLowerCase(), u]));

    const statementsCollection = db.collection("payout_statements");
    const existing = FORCE_REGENERATE
      ? []
      : await statementsCollection
          .find({ creatorAddress: { $in: creatorAddresses }, month: monthKey }, { projection: { creatorAddress: 1 } })
          .toArray();
    const alreadyDone = new Set(existing.map((e) => e.creatorAddress));

    let localOutputDir = null;
    if (!s3 && !DRY_RUN) {
      localOutputDir = process.env.STATEMENTS_LOCAL_DIR || (await mkdtemp(join(tmpdir(), "eduvault-statements-")));
    }

    for (const [creatorAddress, bucket] of byCreator) {
      try {
        if (alreadyDone.has(creatorAddress)) {
          summary.skippedExisting++;
          log("info", "Statement already exists for this creator/month — skipping", { creatorAddress, month: monthKey });
          continue;
        }

        const user = userByAddress.get(String(creatorAddress).toLowerCase());
        const grossRevenueUsd = Object.entries(bucket.grossByCurrency).reduce((sum, [cur, amt]) => {
          const rate = rateFor(currencyRates, cur);
          return rate === null ? sum : sum + amt * rate;
        }, 0);
        const totalPaidOutUsd = Object.entries(bucket.paidByCurrency).reduce((sum, [cur, amt]) => {
          const rate = rateFor(currencyRates, cur);
          return rate === null ? sum : sum + amt * rate;
        }, 0);

        const statement = {
          creator: {
            name: user?.fullName || user?.displayName || null,
            walletAddress: creatorAddress,
            email: user?.email || null,
            preferredPayoutCurrency: user?.preferredPayoutCurrency || null,
          },
          period: { label, from, to },
          summary: {
            salesCount: bucket.sales.length,
            payoutsCount: bucket.payouts.length,
            grossRevenueByCurrency: bucket.grossByCurrency,
            totalPaidOutByCurrency: bucket.paidByCurrency,
            grossRevenueUsd,
            totalPaidOutUsd,
            outstandingBalanceUsd: Math.max(grossRevenueUsd - totalPaidOutUsd, 0),
          },
          currencyRates,
          sales: bucket.sales,
          payouts: bucket.payouts,
          generatedAt: new Date(),
        };

        const pdfBuffer = await generatePayoutStatementPdf(statement, { explorerBaseUrl: EXPLORER_URL });
        summary.generated++;

        if (DRY_RUN) {
          log("info", "DRY_RUN — generated statement, skipping upload/email/record", {
            creatorAddress,
            salesCount: statement.summary.salesCount,
            payoutsCount: statement.summary.payoutsCount,
            grossRevenueUsd,
          });
          continue;
        }

        let accessUrl = null;
        let s3Key = null;
        if (s3) {
          const uploaded = await uploadStatement({ s3, creatorAddress, monthKey, pdfBuffer });
          accessUrl = uploaded.url;
          s3Key = uploaded.key;
          summary.uploaded++;
        } else {
          const localPath = join(localOutputDir, `${creatorAddress}-${monthKey}.pdf`);
          await writeFile(localPath, pdfBuffer);
          log("warn", "No S3 bucket configured — statement saved locally, no access link available to email", {
            creatorAddress,
            localPath,
          });
        }

        if (accessUrl && user?.email) {
          const from_ = process.env.EMAIL_FROM || process.env.EMAIL_USER || process.env.SMTP_USER || "no-reply@eduvault.local";
          const { subject, text } = buildStatementEmail({
            creatorName: statement.creator.name,
            periodLabel: label,
            accessUrl,
            expiresInDays: LINK_EXPIRES_IN_DAYS,
          });
          await mailTransport.sendMail({ from: from_, to: user.email, subject, text });
          summary.emailed++;
        } else if (accessUrl && !user?.email) {
          log("warn", "Statement uploaded but creator has no email on file — not sent", { creatorAddress });
        }

        await statementsCollection.updateOne(
          { creatorAddress, month: monthKey },
          {
            $set: {
              creatorAddress,
              month: monthKey,
              generatedAt: statement.generatedAt,
              s3Key,
              emailedAt: accessUrl && user?.email ? new Date() : null,
              salesCount: statement.summary.salesCount,
              payoutsCount: statement.summary.payoutsCount,
            },
          },
          { upsert: true },
        );
      } catch (err) {
        summary.failed++;
        log("error", "Failed to process statement for creator", { creatorAddress, error: err.message });
      }
    }

    log("info", "─── Summary ───", { month: monthKey, ...summary });
  } finally {
    await client.close();
    log("info", "Done.");
  }
}

run().catch((err) => {
  log("error", "Fatal error", { error: err.message, stack: err.stack });
  process.exit(1);
});
