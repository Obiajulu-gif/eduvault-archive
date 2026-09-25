/**
 * Monthly creator payout statement PDF layout (#293).
 *
 * Pure layout module: takes a plain statement data object and renders a PDF
 * buffer. No database, network, or `@/`-aliased imports — this file is
 * imported both from `scripts/monthly-statements.mjs` (a plain `node`
 * process, where the Next.js `@/` path alias does not resolve) and, if ever
 * needed, from an API route.
 *
 * @typedef {Object} StatementCurrencyRate
 * @property {string} currency        - Asset code (e.g. "USDC", "XLM").
 * @property {number|null} rateToUsd  - 1 unit of `currency` in USD, or null
 *                                       if no rate could be resolved.
 * @property {string} source          - Human-readable provenance of the rate
 *                                       (e.g. "USD-pegged stablecoin",
 *                                       "Stellar DEX monthly volume-weighted
 *                                       average (XLM/USDC)", "unavailable").
 *
 * @typedef {Object} StatementSaleLine
 * @property {Date} date
 * @property {string} materialTitle
 * @property {string} buyerAddress
 * @property {number} amount
 * @property {string} currency
 * @property {string|null} transactionHash
 *
 * @typedef {Object} StatementPayoutLine
 * @property {Date} date
 * @property {number} amount
 * @property {string} currency
 * @property {string} status
 * @property {string|null} transactionHash
 *
 * @typedef {Object} StatementData
 * @property {Object} creator                 - { name, walletAddress, email, preferredPayoutCurrency }
 * @property {Object} period                  - { label, from: Date, to: Date }
 * @property {Object} summary                 - {
 *   salesCount: number,
 *   payoutsCount: number,
 *   grossRevenueByCurrency: Record<string, number>,
 *   totalPaidOutByCurrency: Record<string, number>,
 *   grossRevenueUsd: number|null,
 *   totalPaidOutUsd: number|null,
 *   outstandingBalanceUsd: number|null,
 * }
 * @property {StatementCurrencyRate[]} currencyRates
 * @property {StatementSaleLine[]} sales
 * @property {StatementPayoutLine[]} payouts
 * @property {Date} generatedAt
 */

import { PDFDocument } from "pdfkit";

const PAGE_MARGIN = 50;
const COLORS = {
  brand: "#2563eb",
  heading: "#111827",
  subheading: "#6b7280",
  border: "#d1d5db",
  headerBg: "#f3f4f6",
  body: "#1f2937",
  muted: "#9ca3af",
};

function formatAmount(amount) {
  return (Number(amount) || 0).toFixed(2);
}

function formatUsd(amount) {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return "—";
  return `$${Number(amount).toFixed(2)}`;
}

function formatDate(date) {
  if (!date) return "—";
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

/**
 * Fixed-length truncation for long on-chain identifiers (addresses, tx
 * hashes) so a single table row never wraps to a second line. The full
 * value is still reachable via the accompanying explorer hyperlink.
 */
function truncateId(value, headChars = 8, tailChars = 6) {
  const str = String(value ?? "").trim();
  if (!str || str.length <= headChars + tailChars + 1) return str || "—";
  return `${str.slice(0, headChars)}…${str.slice(-tailChars)}`;
}

/**
 * Truncate `value` with an ellipsis until it fits `maxWidth` under the
 * doc's *currently active* font/fontSize (must be set before calling this).
 * A safety net so any cell — not just the ones the caller already
 * pre-truncated with `truncateId` — can never wrap to a second line and
 * collide with the row below.
 */
function fitCellText(doc, value, maxWidth) {
  if (doc.widthOfString(value) <= maxWidth) return value;
  let str = value;
  while (str.length > 1 && doc.widthOfString(`${str}…`) > maxWidth) {
    str = str.slice(0, -1);
  }
  return `${str}…`;
}

function ensureSpace(doc, neededHeight) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + neededHeight > bottom) {
    doc.addPage();
  }
}

function drawSectionTitle(doc, title) {
  ensureSpace(doc, 34);
  doc.moveDown(0.6);
  doc
    .font("Helvetica-Bold")
    .fontSize(13)
    .fillColor(COLORS.heading)
    .text(title, PAGE_MARGIN, doc.y, { width: doc.page.width - PAGE_MARGIN * 2 });
  doc.moveDown(0.3);
}

/**
 * Render a simple fixed-column table. Cell values are pre-stringified and
 * truncated by the caller (identifier columns) so every row is exactly
 * `rowHeight` tall — this keeps pagination math exact (no mid-row page
 * breaks, no wrapped cells overlapping the next row).
 *
 * @param {InstanceType<typeof PDFDocument>} doc
 * @param {{ label: string, width: number, align?: "left"|"right"|"center", link?: (rowIndex:number)=>string|null }[]} columns
 * @param {string[][]} rows
 */
function drawTable(doc, columns, rows, { rowHeight = 20 } = {}) {
  const startX = PAGE_MARGIN;
  const tableWidth = columns.reduce((sum, c) => sum + c.width, 0);

  function drawHeader() {
    ensureSpace(doc, rowHeight + 6);
    const y = doc.y;
    doc.rect(startX, y, tableWidth, rowHeight).fill(COLORS.headerBg);
    let x = startX;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.heading);
    for (const col of columns) {
      const label = fitCellText(doc, col.label, col.width - 8);
      doc.text(label, x + 4, y + 6, { width: col.width - 8, align: col.align || "left" });
      x += col.width;
    }
    doc.y = y + rowHeight;
  }

  drawHeader();

  if (rows.length === 0) {
    doc.font("Helvetica").fontSize(9).fillColor(COLORS.muted).text("No records for this period.", startX + 4, doc.y + 6);
    doc.y += rowHeight;
    return;
  }

  for (let r = 0; r < rows.length; r++) {
    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      drawHeader();
    }
    const row = rows[r];
    const y = doc.y;
    let x = startX;
    doc.font("Helvetica").fontSize(8).fillColor(COLORS.body);
    for (let c = 0; c < columns.length; c++) {
      const col = columns[c];
      const raw = row[c] == null ? "" : String(row[c]);
      const value = fitCellText(doc, raw, col.width - 8);
      doc.text(value, x + 4, y + 6, { width: col.width - 8, align: col.align || "left" });
      const link = col.link ? col.link(r) : null;
      if (link) {
        doc.link(x, y, col.width, rowHeight, link);
      }
      x += col.width;
    }
    doc
      .moveTo(startX, y + rowHeight)
      .lineTo(startX + tableWidth, y + rowHeight)
      .strokeColor(COLORS.border)
      .lineWidth(0.5)
      .stroke();
    doc.y = y + rowHeight;
  }
}

function explorerTxUrl(explorerBaseUrl, txHash) {
  if (!txHash || !explorerBaseUrl) return null;
  return `${explorerBaseUrl}/tx/${txHash}`;
}

/**
 * Render a monthly creator payout statement as a PDF and return it as a
 * Buffer (collected from the document's Readable stream — see pdfkit's own
 * README "stable, dependency-free alternative" pattern; avoids a temp file).
 *
 * @param {StatementData} statement
 * @param {{ explorerBaseUrl?: string }} [options]
 * @returns {Promise<Buffer>}
 */
export function generatePayoutStatementPdf(statement, options = {}) {
  const { explorerBaseUrl = "" } = options;

  return new Promise((resolvePdf, rejectPdf) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: PAGE_MARGIN,
      info: {
        Title: `EduVault Payout Statement — ${statement.period.label}`,
        Author: "EduVault",
        Subject: `Creator earnings statement for ${statement.creator.walletAddress}`,
        Producer: "EduVault monthly-statements",
      },
    });

    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolvePdf(Buffer.concat(chunks)));
    doc.on("error", rejectPdf);

    // ── Header ──────────────────────────────────────────────────────────
    doc.font("Helvetica-Bold").fontSize(20).fillColor(COLORS.brand).text("EduVault", PAGE_MARGIN, PAGE_MARGIN);
    doc
      .font("Helvetica")
      .fontSize(11)
      .fillColor(COLORS.subheading)
      .text("Monthly Creator Payout Statement", PAGE_MARGIN, doc.y + 2);
    doc.moveDown(0.8);

    doc.font("Helvetica-Bold").fontSize(14).fillColor(COLORS.heading).text(statement.period.label, PAGE_MARGIN, doc.y);
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(COLORS.subheading)
      .text(
        `Period: ${formatDate(statement.period.from)} to ${formatDate(statement.period.to)}`,
        PAGE_MARGIN,
        doc.y + 2,
      );

    doc.moveDown(0.6);
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(COLORS.body)
      .text(`Creator: ${statement.creator.name || "Unnamed creator"}`, PAGE_MARGIN, doc.y)
      .text(`Wallet address: ${statement.creator.walletAddress}`, PAGE_MARGIN, doc.y + 2)
      .text(
        `Preferred payout currency: ${statement.creator.preferredPayoutCurrency || "Not set"}`,
        PAGE_MARGIN,
        doc.y + 2,
      );

    doc
      .moveTo(PAGE_MARGIN, doc.y + 10)
      .lineTo(doc.page.width - PAGE_MARGIN, doc.y + 10)
      .strokeColor(COLORS.border)
      .lineWidth(1)
      .stroke();
    doc.y += 20;

    // ── Summary ─────────────────────────────────────────────────────────
    drawSectionTitle(doc, "Summary");
    const { summary } = statement;
    const grossByCurrencyText = Object.entries(summary.grossRevenueByCurrency)
      .map(([cur, amt]) => `${formatAmount(amt)} ${cur}`)
      .join(", ") || "None";
    const paidByCurrencyText = Object.entries(summary.totalPaidOutByCurrency)
      .map(([cur, amt]) => `${formatAmount(amt)} ${cur}`)
      .join(", ") || "None";

    const summaryRows = [
      ["Sales count", String(summary.salesCount)],
      ["Gross revenue (by currency)", grossByCurrencyText],
      ["Gross revenue (USD equivalent)", formatUsd(summary.grossRevenueUsd)],
      ["Payouts count", String(summary.payoutsCount)],
      ["Total paid out (by currency)", paidByCurrencyText],
      ["Total paid out (USD equivalent)", formatUsd(summary.totalPaidOutUsd)],
      ["Outstanding balance (USD equivalent)", formatUsd(summary.outstandingBalanceUsd)],
    ];
    drawTable(
      doc,
      [
        { label: "Metric", width: 220 },
        { label: "Value", width: doc.page.width - PAGE_MARGIN * 2 - 220 },
      ],
      summaryRows,
    );

    // ── Currency rates ──────────────────────────────────────────────────
    drawSectionTitle(doc, "Currency Rates");
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(COLORS.subheading)
      .text(
        "USD-pegged stablecoins are reported at a fixed 1:1 rate. The XLM rate is a volume-weighted " +
          "average of Stellar DEX daily trade aggregations (XLM/USDC) across this statement period.",
        PAGE_MARGIN,
        doc.y,
        { width: doc.page.width - PAGE_MARGIN * 2 },
      );
    doc.moveDown(0.4);
    drawTable(
      doc,
      [
        { label: "Currency", width: 100 },
        { label: "Rate to USD", width: 120, align: "right" },
        { label: "Source", width: doc.page.width - PAGE_MARGIN * 2 - 220 },
      ],
      statement.currencyRates.map((r) => [
        r.currency,
        r.rateToUsd === null ? "unavailable" : r.rateToUsd.toFixed(4),
        r.source,
      ]),
    );

    // ── Sales ───────────────────────────────────────────────────────────
    drawSectionTitle(doc, `Sales (${statement.sales.length})`);
    const saleColWidths = { date: 65, material: 150, buyer: 100, amount: 70, currency: 55 };
    const txColWidth = doc.page.width - PAGE_MARGIN * 2 - Object.values(saleColWidths).reduce((a, b) => a + b, 0);
    drawTable(
      doc,
      [
        { label: "Date", width: saleColWidths.date },
        { label: "Material", width: saleColWidths.material },
        { label: "Buyer", width: saleColWidths.buyer },
        { label: "Amount", width: saleColWidths.amount, align: "right" },
        { label: "Currency", width: saleColWidths.currency },
        {
          label: "Tx Hash",
          width: txColWidth,
          link: (i) => explorerTxUrl(explorerBaseUrl, statement.sales[i].transactionHash),
        },
      ],
      statement.sales.map((s) => [
        formatDate(s.date),
        s.materialTitle,
        truncateId(s.buyerAddress),
        formatAmount(s.amount),
        s.currency,
        truncateId(s.transactionHash, 8, 6),
      ]),
    );

    // ── Payouts ─────────────────────────────────────────────────────────
    drawSectionTitle(doc, `Payouts (${statement.payouts.length})`);
    const payoutColWidths = { date: 70, amount: 80, currency: 60, status: 90 };
    const payoutTxWidth =
      doc.page.width - PAGE_MARGIN * 2 - Object.values(payoutColWidths).reduce((a, b) => a + b, 0);
    drawTable(
      doc,
      [
        { label: "Date", width: payoutColWidths.date },
        { label: "Amount", width: payoutColWidths.amount, align: "right" },
        { label: "Currency", width: payoutColWidths.currency },
        { label: "Status", width: payoutColWidths.status },
        {
          label: "Payout Tx Hash",
          width: payoutTxWidth,
          link: (i) => explorerTxUrl(explorerBaseUrl, statement.payouts[i].transactionHash),
        },
      ],
      statement.payouts.map((p) => [
        formatDate(p.date),
        formatAmount(p.amount),
        p.currency,
        p.status,
        p.transactionHash ? truncateId(p.transactionHash, 8, 6) : "pending",
      ]),
    );

    // ── Footer ──────────────────────────────────────────────────────────
    ensureSpace(doc, 60);
    doc.moveDown(1);
    doc
      .font("Helvetica")
      .fontSize(7)
      .fillColor(COLORS.muted)
      .text(
        "This statement is generated automatically from EduVault platform records for informational " +
          "purposes and does not constitute tax or legal advice. Verify on-chain figures independently " +
          "via the linked Stellar transaction hashes before filing.",
        PAGE_MARGIN,
        doc.y,
        { width: doc.page.width - PAGE_MARGIN * 2 },
      )
      .text(`Generated ${statement.generatedAt.toISOString()}`, PAGE_MARGIN, doc.y + 4);

    doc.end();
  });
}
