import nodemailer from 'nodemailer'

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
// Suspension email
// ---------------------------------------------------------------------------
function buildSuspensionHtml({ name, reason, appealEmail }) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const supportEmail = appealEmail || process.env.SUPPORT_EMAIL || process.env.EMAIL_FROM || process.env.EMAIL_USER || 'support@eduvault.local'

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Your EduVault Account Has Been Suspended</title>
  <style>
    @media (prefers-color-scheme:dark){
      .card{background:#111827!important;color:#e5e7eb!important;}
      .muted{color:#9ca3af!important;}
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f6f9fc;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6f9fc;">
    <tr><td align="center" style="padding:24px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;">
        <tr>
          <td style="padding:0 0 12px 0;" align="center">
            <a href="${appUrl}" style="text-decoration:none;color:#111827;">
              <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-weight:700;font-size:18px;">EduVault</span>
            </a>
          </td>
        </tr>
        <tr>
          <td class="card" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.06);">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td style="padding:0;">
                  <div style="background:#dc2626;padding:16px 24px;">
                    <p style="margin:0;font-size:13px;font-weight:600;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:0.05em;text-transform:uppercase;">Account Notice</p>
                  </div>
                </td>
              </tr>
              <tr>
                <td style="padding:24px 24px 8px 24px;">
                  <h1 style="margin:0 0 12px 0;font-size:20px;line-height:1.3;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                    Your account has been suspended
                  </h1>
                  <p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#374151;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                    Hi ${name},
                  </p>
                  <p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#374151;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                    We've temporarily suspended access to your EduVault account. Here's why:
                  </p>
                  <div style="background:#fef2f2;border-left:4px solid #dc2626;border-radius:4px;padding:12px 16px;margin:0 0 20px 0;">
                    <p style="margin:0;font-size:14px;line-height:1.6;color:#7f1d1d;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                      ${reason || 'Violation of EduVault community guidelines or terms of service.'}
                    </p>
                  </div>
                  <p style="margin:0 0 8px 0;font-size:14px;font-weight:600;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">What this means:</p>
                  <ul style="margin:0 0 20px 0;padding-left:20px;">
                    <li style="font-size:14px;line-height:1.8;color:#374151;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">You cannot log in to your account while it is suspended.</li>
                    <li style="font-size:14px;line-height:1.8;color:#374151;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Your published materials will be unlisted for the duration of the suspension.</li>
                    <li style="font-size:14px;line-height:1.8;color:#374151;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Pending payouts may be placed on hold.</li>
                  </ul>
                  <p style="margin:0 0 8px 0;font-size:14px;font-weight:600;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">How to appeal:</p>
                  <p style="margin:0 0 20px 0;font-size:14px;line-height:1.6;color:#374151;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                    If you believe this action was taken in error, you can appeal by replying to this email or contacting us at
                    <a href="mailto:${supportEmail}" style="color:#2563eb;text-decoration:none;">${supportEmail}</a>.
                    Please include your account email address and a brief explanation.
                  </p>
                  <p style="margin:0 0 8px 0;font-size:14px;font-weight:600;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Our guidelines:</p>
                  <p style="margin:0 0 24px 0;font-size:14px;line-height:1.6;color:#374151;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                    You can read our full community guidelines and terms of service at
                    <a href="${appUrl}/terms" style="color:#2563eb;text-decoration:none;">${appUrl}/terms</a>.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:16px 8px 0 8px;">
            <p class="muted" style="margin:0 0 8px 0;font-size:12px;color:#6b7280;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              You're receiving this because your EduVault account status changed.
            </p>
            <p class="muted" style="margin:0 0 24px 0;font-size:12px;color:#6b7280;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              © ${new Date().getUTCFullYear()} EduVault
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

function buildSuspensionText({ name, reason, appealEmail }) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const supportEmail = appealEmail || process.env.SUPPORT_EMAIL || process.env.EMAIL_FROM || process.env.EMAIL_USER || 'support@eduvault.local'
  return [
    `Hi ${name},`,
    ``,
    `Your EduVault account has been suspended.`,
    ``,
    `Reason: ${reason || 'Violation of EduVault community guidelines or terms of service.'}`,
    ``,
    `What this means:`,
    `- You cannot log in while your account is suspended.`,
    `- Your published materials will be unlisted for the duration of the suspension.`,
    `- Pending payouts may be placed on hold.`,
    ``,
    `How to appeal:`,
    `Reply to this email or contact us at ${supportEmail}. Please include your account`,
    `email address and a brief explanation if you believe this is an error.`,
    ``,
    `Community guidelines: ${appUrl}/terms`,
    ``,
    `EduVault Team`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Reactivation email
// ---------------------------------------------------------------------------
function buildReactivationHtml({ name }) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const dashboardUrl = `${appUrl}/dashboard`

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Your EduVault Account Has Been Reactivated</title>
  <style>
    @media (prefers-color-scheme:dark){
      .card{background:#111827!important;color:#e5e7eb!important;}
      .muted{color:#9ca3af!important;}
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f6f9fc;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6f9fc;">
    <tr><td align="center" style="padding:24px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;">
        <tr>
          <td style="padding:0 0 12px 0;" align="center">
            <a href="${appUrl}" style="text-decoration:none;color:#111827;">
              <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-weight:700;font-size:18px;">EduVault</span>
            </a>
          </td>
        </tr>
        <tr>
          <td class="card" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.06);">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td style="padding:0;">
                  <div style="background:#16a34a;padding:16px 24px;">
                    <p style="margin:0;font-size:13px;font-weight:600;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:0.05em;text-transform:uppercase;">Account Restored</p>
                  </div>
                </td>
              </tr>
              <tr>
                <td style="padding:24px 24px 8px 24px;">
                  <h1 style="margin:0 0 12px 0;font-size:20px;line-height:1.3;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                    Your account has been reactivated
                  </h1>
                  <p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#374151;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                    Hi ${name},
                  </p>
                  <p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#374151;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                    Good news — your EduVault account has been fully reinstated. You can now log in and access all features as normal.
                  </p>
                  <p style="margin:0 0 20px 0;font-size:14px;line-height:1.6;color:#374151;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                    Please review our community guidelines to ensure continued access:
                    <a href="${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/terms" style="color:#2563eb;text-decoration:none;">${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/terms</a>.
                  </p>
                  <div style="margin:0 0 24px 0;">
                    <a href="${dashboardUrl}" style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;padding:12px 16px;border-radius:8px;font-weight:600;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                      Go to your dashboard
                    </a>
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:16px 8px 0 8px;">
            <p class="muted" style="margin:0 0 24px 0;font-size:12px;color:#6b7280;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              © ${new Date().getUTCFullYear()} EduVault
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

function buildReactivationText({ name }) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  return [
    `Hi ${name},`,
    ``,
    `Your EduVault account has been fully reinstated.`,
    `You can now log in and access all features as normal.`,
    ``,
    `Please review our guidelines to ensure continued access: ${appUrl}/terms`,
    ``,
    `EduVault Team`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sends a suspension notification email to the affected user.
 *
 * @param {{ to: string, name: string, reason?: string, appealEmail?: string }} opts
 */
export async function sendSuspensionEmail({ to, name, reason, appealEmail }) {
  const from = process.env.EMAIL_FROM || process.env.EMAIL_USER || 'no-reply@eduvault.local'
  const transporter = createTransporter()

  await transporter.sendMail({
    from,
    to,
    subject: 'Important: Your EduVault account has been suspended',
    text: buildSuspensionText({ name, reason, appealEmail }),
    html: buildSuspensionHtml({ name, reason, appealEmail }),
  })
}

/**
 * Sends a reactivation notification email to the affected user.
 *
 * @param {{ to: string, name: string }} opts
 */
export async function sendReactivationEmail({ to, name }) {
  const from = process.env.EMAIL_FROM || process.env.EMAIL_USER || 'no-reply@eduvault.local'
  const transporter = createTransporter()

  await transporter.sendMail({
    from,
    to,
    subject: 'Good news: Your EduVault account has been reactivated',
    text: buildReactivationText({ name }),
    html: buildReactivationHtml({ name }),
  })
}
