import nodemailer from 'nodemailer'
import { getDb } from '@/lib/mongodb'

// ---------------------------------------------------------------------------
// Transporter
// ---------------------------------------------------------------------------
function createTransporter() {
  const smtpHost = process.env.SMTP_HOST
  const smtpPort = Number(process.env.SMTP_PORT || 0)
  const smtpUser = process.env.SMTP_USER || process.env.EMAIL_USER
  const smtpPass = process.env.SMTP_PASS || process.env.EMAIL_PASS

  if (smtpHost) {
    const port = smtpPort || 587
    return nodemailer.createTransport({
      host: smtpHost,
      port,
      secure: port === 465,
      auth: { user: smtpUser, pass: smtpPass },
    })
  }

  if (!smtpUser || !smtpPass) {
    throw new Error('Email credentials missing (EMAIL_USER/EMAIL_PASS or SMTP_*)')
  }

  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: smtpUser, pass: smtpPass },
  })
}

// ---------------------------------------------------------------------------
// Stats aggregation
// ---------------------------------------------------------------------------

/**
 * Returns the UTC start of `n` weeks ago (Monday 00:00:00 UTC).
 */
function weekStart(weeksAgo = 1) {
  const now = new Date()
  const dayOfWeek = now.getUTCDay() // 0=Sun … 6=Sat
  const daysToLastMonday = ((dayOfWeek + 6) % 7) + (weeksAgo - 1) * 7
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysToLastMonday)
  )
  return start
}

/**
 * Fetches marketplace performance statistics for the previous calendar week.
 *
 * @returns {Promise<{
 *   weekStart: string,
 *   weekEnd: string,
 *   totalSales: number,
 *   totalRevenue: number,
 *   newRegistrations: number,
 *   activeListings: number,
 *   newMaterials: number,
 * }>}
 */
export async function fetchWeeklyStats() {
  const db = await getDb()
  const start = weekStart(1)
  const end = weekStart(0) // start of current week = end of last week

  const [salesResult, registrations, activeListings, newMaterials] = await Promise.all([
    // Total completed purchases + revenue in the window
    db.collection('purchases').aggregate([
      { $match: { createdAt: { $gte: start.toISOString(), $lt: end.toISOString() }, status: 'completed' } },
      { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: { $toDouble: '$price' } } } },
    ]).toArray(),

    // New user registrations
    db.collection('users').countDocuments({
      createdAt: { $gte: start.toISOString(), $lt: end.toISOString() },
    }),

    // Active material listings (all time, currently active)
    db.collection('materials').countDocuments({ visibility: 'public', status: { $ne: 'removed' } }),

    // Materials uploaded in the window
    db.collection('materials').countDocuments({
      createdAt: { $gte: start.toISOString(), $lt: end.toISOString() },
    }),
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
// Email template
// ---------------------------------------------------------------------------
function buildReportHtml(stats) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const weekLabel = new Date(stats.weekStart).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })
  const weekEndLabel = new Date(stats.weekEnd).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })

  const row = (label, value) => `
    <tr>
      <td style="padding:10px 16px;font-size:14px;color:#374151;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;border-bottom:1px solid #f3f4f6;">${label}</td>
      <td style="padding:10px 16px;font-size:14px;font-weight:700;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;border-bottom:1px solid #f3f4f6;text-align:right;">${value}</td>
    </tr>`

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>EduVault Weekly Report</title>
  <style>
    @media (prefers-color-scheme:dark){
      .card{background:#111827!important;color:#e5e7eb!important;}
      .muted{color:#9ca3af!important;}
      td{color:#d1d5db!important;}
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f6f9fc;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6f9fc;">
    <tr><td align="center" style="padding:24px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;">
        <tr>
          <td style="padding:0 0 12px 0;" align="center">
            <a href="${appUrl}" style="text-decoration:none;display:inline-flex;align-items:center;gap:8px;color:#111827;">
              <img src="${appUrl}/images/stellar.png" width="36" height="36" alt="EduVault" style="border:0;display:block;"/>
              <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-weight:700;font-size:18px;">EduVault</span>
            </a>
          </td>
        </tr>
        <tr>
          <td class="card" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.06);">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td style="padding:24px 24px 8px 24px;">
                  <h1 style="margin:0 0 4px 0;font-size:20px;line-height:1.3;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                    Weekly Marketplace Report
                  </h1>
                  <p class="muted" style="margin:0 0 20px 0;font-size:13px;color:#6b7280;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                    ${weekLabel} – ${weekEndLabel}
                  </p>
                </td>
              </tr>
              <tr>
                <td style="padding:0 16px 16px 16px;">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
                    ${row('Total completed sales', stats.totalSales.toLocaleString())}
                    ${row('Total revenue (XLM)', stats.totalRevenue.toLocaleString())}
                    ${row('New user registrations', stats.newRegistrations.toLocaleString())}
                    ${row('New materials uploaded', stats.newMaterials.toLocaleString())}
                    ${row('Active listings (all time)', stats.activeListings.toLocaleString())}
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding:0 24px 24px 24px;">
                  <a href="${appUrl}/admin" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 16px;border-radius:8px;font-weight:600;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                    View admin dashboard
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:16px 8px 0 8px;">
            <p class="muted" style="margin:0 0 24px 0;font-size:12px;color:#6b7280;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              © ${new Date().getUTCFullYear()} EduVault · Automated weekly report
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

function buildReportText(stats) {
  const weekLabel = new Date(stats.weekStart).toISOString().slice(0, 10)
  const weekEndLabel = new Date(stats.weekEnd).toISOString().slice(0, 10)
  return [
    `EduVault Weekly Marketplace Report`,
    `Period: ${weekLabel} – ${weekEndLabel}`,
    ``,
    `Total completed sales : ${stats.totalSales}`,
    `Total revenue (XLM)   : ${stats.totalRevenue}`,
    `New registrations     : ${stats.newRegistrations}`,
    `New materials uploaded : ${stats.newMaterials}`,
    `Active listings       : ${stats.activeListings}`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Send report
// ---------------------------------------------------------------------------

/**
 * Sends the weekly stats email to all configured admin addresses.
 *
 * @param {object} [overrideStats] - Optional pre-fetched stats (useful in tests).
 * @returns {Promise<{ delivered: string[], stats: object }>}
 */
export async function sendWeeklyAdminReport(overrideStats) {
  const adminEmails = (process.env.ADMIN_REPORT_EMAILS || process.env.EMAIL_USER || '')
    .split(',')
    .map(e => e.trim())
    .filter(Boolean)

  if (adminEmails.length === 0) {
    throw new Error('No admin email addresses configured (set ADMIN_REPORT_EMAILS)')
  }

  const stats = overrideStats || (await fetchWeeklyStats())
  const transporter = createTransporter()
  const from = process.env.EMAIL_FROM || process.env.EMAIL_USER || 'no-reply@eduvault.local'
  const subject = `EduVault Weekly Report — w/c ${new Date(stats.weekStart).toISOString().slice(0, 10)}`

  await transporter.sendMail({
    from,
    to: adminEmails.join(', '),
    subject,
    text: buildReportText(stats),
    html: buildReportHtml(stats),
  })

  return { delivered: adminEmails, stats }
}
