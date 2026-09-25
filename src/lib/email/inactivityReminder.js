import nodemailer from "nodemailer";

function createTransporter() {
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = Number(process.env.SMTP_PORT || 0);
  const smtpUser = process.env.SMTP_USER || process.env.EMAIL_USER;
  const smtpPass = process.env.SMTP_PASS || process.env.EMAIL_PASS;

  if (smtpHost) {
    const port = smtpPort || 587;
    return nodemailer.createTransport({
      host: smtpHost,
      port,
      secure: port === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });
  }

  if (!smtpUser || !smtpPass) {
    throw new Error("Email credentials missing (EMAIL_USER/EMAIL_PASS or SMTP_*)");
  }

  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: smtpUser, pass: smtpPass },
  });
}

/**
 * Send an inactivity reminder email to a creator whose profile has been
 * dormant for more than the configured threshold (default 180 days).
 *
 * @param {string} to        – recipient email address
 * @param {string} name      – creator display name
 * @param {number} inactiveDays – number of days since last activity
 * @param {{ materialCount: number, demotedCount: number }} stats
 * @returns {Promise<void>}
 */
export async function sendInactivityReminder(to, name, inactiveDays, stats) {
  const defaultFrom = process.env.EMAIL_USER || "no-reply@eduvault.local";
  const from = process.env.EMAIL_FROM || defaultFrom;
  const transporter = createTransporter();

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const dashboardUrl = `${appUrl}/dashboard`;
  const profileUrl = `${appUrl}/profile`;

  const subject = `Your EduVault catalog needs attention — ${inactiveDays} days inactive`;

  const text = [
    `Hi ${name},`,
    "",
    `Your EduVault profile has been inactive for ${inactiveDays} days.`,
    "",
    stats.demotedCount > 0
      ? `${stats.demotedCount} of your ${stats.materialCount} catalog item(s) have been marked as low-relevance and may not appear in marketplace search results.`
      : `You have ${stats.materialCount} published item(s). If your profile stays inactive, items may be flagged as low-relevance.`,
    "",
    "To keep your catalog visible:",
    "  1. Log in and review your published materials.",
    "  2. Update descriptions, pricing, or thumbnails.",
    "  3. Publish new content to signal active stewardship.",
    "",
    `Dashboard: ${dashboardUrl}`,
    `Profile: ${profileUrl}`,
    "",
    "If you no longer plan to maintain your catalog, consider unpublishing your materials to keep the marketplace high-quality.",
    "",
    "— EduVault Team",
  ].join("\n");

  const html = `
  <!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>EduVault Inactivity Reminder</title>
      <style>
        @media (prefers-color-scheme: dark) {
          .card { background: #111827 !important; color: #e5e7eb !important; }
          .muted { color: #9ca3af !important; }
          .btn { background: #2563eb !important; }
          .stat { background: #1f2937 !important; border-color: #374151 !important; }
        }
      </style>
    </head>
    <body style="margin:0;padding:0;background:#f6f9fc;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6f9fc;">
        <tr>
          <td align="center" style="padding:24px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;">
              <tr>
                <td style="padding:0 0 12px 0;" align="center">
                  <a href="${appUrl}" style="text-decoration:none;display:inline-flex;align-items:center;gap:8px;color:#111827;">
                    <img src="${appUrl}/images/stellar.png" width="36" height="36" alt="EduVault" style="border:0;display:block;" />
                    <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji';font-weight:700;font-size:18px;">EduVault</span>
                  </a>
                </td>
              </tr>
              <tr>
                <td class="card" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.06);">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                    <tr>
                      <td style="padding:24px 24px 8px 24px;">
                        <h1 style="margin:0 0 8px 0;font-size:22px;line-height:1.3;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji';">
                          Your catalog needs attention
                        </h1>
                        <p class="muted" style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#6b7280;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji';">
                          Hi ${name}, your EduVault profile has been inactive for <strong>${inactiveDays} days</strong>.
                        </p>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:0 24px 16px 24px;">
                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                          <tr>
                            <td class="stat" style="background:#f0f4ff;border:1px solid #e0e7ff;border-radius:8px;padding:12px 16px;">
                              <p style="margin:0 0 4px 0;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#6b7280;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Catalog items</p>
                              <p style="margin:0;font-size:20px;font-weight:700;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${stats.materialCount}</p>
                            </td>
                            ${stats.demotedCount > 0 ? `
                            <td style="width:8px;"></td>
                            <td class="stat" style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 16px;">
                              <p style="margin:0 0 4px 0;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#6b7280;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Low-relevance flagged</p>
                              <p style="margin:0;font-size:20px;font-weight:700;color:#dc2626;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${stats.demotedCount}</p>
                            </td>` : ''}
                          </tr>
                        </table>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:0 24px 8px 24px;">
                        <p style="margin:0 0 8px 0;font-size:14px;line-height:1.6;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji';">
                          ${stats.demotedCount > 0
                            ? `${stats.demotedCount} of your items have been marked as <strong>low-relevance</strong> and may not appear in marketplace search results.`
                            : `If your profile stays inactive, your ${stats.materialCount} published item(s) may be flagged as low-relevance.`
                          }
                        </p>
                        <p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji';">
                          To keep your catalog visible:
                        </p>
                        <ol style="margin:0 0 16px 0;padding-left:20px;font-size:14px;line-height:1.8;color:#374151;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji';">
                          <li>Log in and review your published materials</li>
                          <li>Update descriptions, pricing, or thumbnails</li>
                          <li>Publish new content to signal active stewardship</li>
                        </ol>
                        <div style="margin:20px 0;">
                          <a class="btn" href="${dashboardUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 16px;border-radius:8px;font-weight:600;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji';">
                            Go to your dashboard
                          </a>
                        </div>
                        <p class="muted" style="margin:0;font-size:13px;line-height:1.6;color:#6b7280;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji';">
                          If you no longer plan to maintain your catalog, consider unpublishing your materials to keep the marketplace high-quality.
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding:16px 8px 0 8px;">
                  <p class="muted" style="margin:0 0 8px 0;font-size:12px;color:#6b7280;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji';">
                    You're receiving this because you have a creator profile on EduVault.
                  </p>
                  <p class="muted" style="margin:0 0 24px 0;font-size:12px;color:#6b7280;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji';">
                    &copy; ${new Date().getFullYear()} EduVault
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
  </html>`;

  await transporter.sendMail({ from, to, subject, text, html });
}
