#!/usr/bin/env node
/**
 * Weekly marketplace performance email report (#363).
 *
 * Aggregates last-week's platform statistics and emails a summary to all
 * configured admin addresses via Nodemailer.
 *
 * Intended to run every Monday via cron or a task scheduler:
 *   0 8 * * 1  node scripts/weekly-admin-stats.mjs
 *
 * Required env vars:
 *   MONGODB_URI            — MongoDB connection string
 *   EMAIL_USER / EMAIL_PASS — SMTP credentials (or SMTP_HOST / SMTP_USER / SMTP_PASS)
 *   ADMIN_REPORT_EMAILS    — comma-separated list of admin email addresses
 *
 * Optional env vars:
 *   SMTP_HOST / SMTP_PORT  — explicit SMTP server settings
 *   EMAIL_FROM             — sender address (defaults to EMAIL_USER)
 *   NEXT_PUBLIC_APP_URL    — base URL used in email links
 *   MONGODB_DB             — override database name
 */

import { config } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '../.env.local'), override: false })
config({ path: resolve(__dirname, '../.env'), override: false })

// ---------------------------------------------------------------------------
// Structured logger
// ---------------------------------------------------------------------------
function log(level, message, extra = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...extra }))
}

// ---------------------------------------------------------------------------
// Env validation
// ---------------------------------------------------------------------------
function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    log('error', `Missing required environment variable: ${name}`)
    process.exit(1)
  }
  return value
}

requireEnv('MONGODB_URI')

// Ensure at least one email credential path is available
if (!process.env.ADMIN_REPORT_EMAILS) {
  log('warn', 'ADMIN_REPORT_EMAILS not set — will fall back to EMAIL_USER as recipient')
}
if (!process.env.EMAIL_USER && !process.env.SMTP_USER) {
  log('error', 'No email credentials found (set EMAIL_USER/EMAIL_PASS or SMTP_USER/SMTP_PASS)')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Dynamic imports (avoids bundling issues with Next.js path aliases)
// ---------------------------------------------------------------------------
async function loadDeps() {
  // MongoDB
  const { MongoClient } = await import('mongodb')
  const nodemailer = (await import('nodemailer')).default

  return { MongoClient, nodemailer }
}

// ---------------------------------------------------------------------------
// Stats aggregation (inlined to avoid @/ alias resolution outside Next.js)
// ---------------------------------------------------------------------------
function weekStart(weeksAgo = 1) {
  const now = new Date()
  const dayOfWeek = now.getUTCDay()
  const daysToLastMonday = ((dayOfWeek + 6) % 7) + (weeksAgo - 1) * 7
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysToLastMonday)
  )
}

async function fetchWeeklyStats(db) {
  const start = weekStart(1)
  const end = weekStart(0)

  const [salesResult, registrations, activeListings, newMaterials] = await Promise.all([
    db.collection('purchases').aggregate([
      { $match: { createdAt: { $gte: start.toISOString(), $lt: end.toISOString() }, status: 'completed' } },
      { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: { $toDouble: '$price' } } } },
    ]).toArray(),
    db.collection('users').countDocuments({ createdAt: { $gte: start.toISOString(), $lt: end.toISOString() } }),
    db.collection('materials').countDocuments({ visibility: 'public', status: { $ne: 'removed' } }),
    db.collection('materials').countDocuments({ createdAt: { $gte: start.toISOString(), $lt: end.toISOString() } }),
  ])

  const salesData = salesResult[0] || { count: 0, revenue: 0 }
  return {
    weekStart: start.toISOString(),
    weekEnd: end.toISOString(),
    totalSales: salesData.count,
    totalRevenue: Number(salesData.revenue.toFixed(2)),
    newRegistrations: registrations,
    activeListings,
    newMaterials,
  }
}

// ---------------------------------------------------------------------------
// Email builders
// ---------------------------------------------------------------------------
function buildText(stats) {
  return [
    'EduVault Weekly Marketplace Report',
    `Period: ${stats.weekStart.slice(0, 10)} – ${stats.weekEnd.slice(0, 10)}`,
    '',
    `Total completed sales : ${stats.totalSales}`,
    `Total revenue (XLM)   : ${stats.totalRevenue}`,
    `New registrations     : ${stats.newRegistrations}`,
    `New materials uploaded : ${stats.newMaterials}`,
    `Active listings       : ${stats.activeListings}`,
  ].join('\n')
}

function buildHtml(stats) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const weekLabel = new Date(stats.weekStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  const weekEndLabel = new Date(stats.weekEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

  const row = (label, value) => `
    <tr>
      <td style="padding:10px 16px;font-size:14px;color:#374151;font-family:system-ui,sans-serif;border-bottom:1px solid #f3f4f6;">${label}</td>
      <td style="padding:10px 16px;font-size:14px;font-weight:700;color:#111827;font-family:system-ui,sans-serif;border-bottom:1px solid #f3f4f6;text-align:right;">${value}</td>
    </tr>`

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
  <title>EduVault Weekly Report</title></head>
  <body style="margin:0;padding:0;background:#f6f9fc;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
    <tr><td align="center" style="padding:24px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;">
        <tr><td align="center" style="padding:0 0 12px 0;">
          <span style="font-family:system-ui,sans-serif;font-weight:700;font-size:18px;color:#111827;">EduVault</span>
        </td></tr>
        <tr><td style="background:#fff;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,0.06);overflow:hidden;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr><td style="padding:24px 24px 8px 24px;">
              <h1 style="margin:0 0 4px 0;font-size:20px;color:#111827;font-family:system-ui,sans-serif;">Weekly Marketplace Report</h1>
              <p style="margin:0 0 20px 0;font-size:13px;color:#6b7280;font-family:system-ui,sans-serif;">${weekLabel} – ${weekEndLabel}</p>
            </td></tr>
            <tr><td style="padding:0 16px 16px 16px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
                ${row('Total completed sales', stats.totalSales.toLocaleString())}
                ${row('Total revenue (XLM)', stats.totalRevenue.toLocaleString())}
                ${row('New user registrations', stats.newRegistrations.toLocaleString())}
                ${row('New materials uploaded', stats.newMaterials.toLocaleString())}
                ${row('Active listings (all time)', stats.activeListings.toLocaleString())}
              </table>
            </td></tr>
            <tr><td style="padding:0 24px 24px 24px;">
              <a href="${appUrl}/admin" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 16px;border-radius:8px;font-weight:600;font-size:14px;font-family:system-ui,sans-serif;">View admin dashboard</a>
            </td></tr>
          </table>
        </td></tr>
        <tr><td align="center" style="padding:16px 0 0 0;">
          <p style="font-size:12px;color:#9ca3af;font-family:system-ui,sans-serif;">© ${new Date().getUTCFullYear()} EduVault · Automated weekly report</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
  </body></html>`
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
;(async () => {
  log('info', 'Weekly admin stats report started')

  const { MongoClient, nodemailer } = await loadDeps()

  const uri = process.env.MONGODB_URI
  const dbName = process.env.MONGODB_DB || new URL(uri.replace(/\?.*$/, '')).pathname.replace(/^\//, '') || 'eduvault'

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 })
  await client.connect()
  log('info', 'Connected to MongoDB', { db: dbName })

  let stats
  try {
    const db = client.db(dbName)
    stats = await fetchWeeklyStats(db)
    log('info', 'Stats aggregated', { stats })
  } finally {
    await client.close()
  }

  // Build transporter
  const smtpHost = process.env.SMTP_HOST
  const smtpPort = Number(process.env.SMTP_PORT || 0)
  const smtpUser = process.env.SMTP_USER || process.env.EMAIL_USER
  const smtpPass = process.env.SMTP_PASS || process.env.EMAIL_PASS
  const from = process.env.EMAIL_FROM || smtpUser || 'no-reply@eduvault.local'

  let transport
  if (smtpHost) {
    const port = smtpPort || 587
    transport = nodemailer.createTransport({ host: smtpHost, port, secure: port === 465, auth: { user: smtpUser, pass: smtpPass } })
  } else {
    transport = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: smtpUser, pass: smtpPass } })
  }

  const recipients = (process.env.ADMIN_REPORT_EMAILS || smtpUser || '')
    .split(',').map(e => e.trim()).filter(Boolean)

  if (recipients.length === 0) {
    log('error', 'No recipient addresses found — aborting')
    process.exit(1)
  }

  const subject = `EduVault Weekly Report — w/c ${stats.weekStart.slice(0, 10)}`
  await transport.sendMail({ from, to: recipients.join(', '), subject, text: buildText(stats), html: buildHtml(stats) })

  log('info', 'Weekly report delivered', { recipients, subject })
})()
