import nodemailer from "nodemailer";
import { ObjectId } from "mongodb";


function createTransporter() {
  // Prefer explicit SMTP settings; fallback to Gmail using EMAIL_USER/PASS
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

  // Gmail default
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: smtpUser, pass: smtpPass },
  });
}

export async function sendWelcomeEmail(to, name) {
  const defaultFrom = process.env.EMAIL_USER || "no-reply@eduvault.local";
  const from = process.env.EMAIL_FROM || defaultFrom;
  const transporter = createTransporter();

  const subject = `Welcome to EduVault, ${name}!`;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const dashboardUrl = `${appUrl}/dashboard`;

  const text = `Hi ${name},\n\nWelcome to EduVault! Your student profile has been created.\n\nHead to your dashboard to start exploring, upload study materials, and share to earn.\n\nDashboard: ${dashboardUrl}\n\nCheers,\nEduVault Team`;

  const html = `
  <!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Welcome to EduVault</title>
      <style>
        /* Email-safe inline styles are applied via attributes; minimal resets here */
        @media (prefers-color-scheme: dark) {
          .card { background: #111827 !important; color: #e5e7eb !important; }
          .muted { color: #9ca3af !important; }
          .btn { background: #2563eb !important; }
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
                          Welcome to EduVault, ${name}!
                        </h1>
                        <p class="muted" style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#6b7280;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji';">
                          Your student profile is ready. Explore your dashboard to discover resources, upload materials, and start sharing to earn.
                        </p>
                        <div style="margin:20px 0;">
                          <a class="btn" href="${dashboardUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 16px;border-radius:8px;font-weight:600;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji';">
                            Go to your dashboard
                          </a>
                        </div>
                        <p style="margin:0 0 8px 0;font-size:14px;line-height:1.6;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji';">
                          Need help? Reply to this email and we’ll assist.
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding:16px 8px 0 8px;">
                  <p class="muted" style="margin:0 0 8px 0;font-size:12px;color:#6b7280;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji';">
                    You’re receiving this because you created a profile on EduVault.
                  </p>
                  <p class="muted" style="margin:0 0 24px 0;font-size:12px;color:#6b7280;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji';">
                    © ${new Date().getFullYear()} EduVault
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

export async function verifyEmailConnection() {
  const transporter = createTransporter();
  await transporter.verify();
}

export async function sendPurchaseReceiptEmail(to, purchase, material) {
  const defaultFrom = process.env.EMAIL_USER || "no-reply@eduvault.local";
  const from = process.env.EMAIL_FROM || defaultFrom;
  const transporter = createTransporter();

  const title = material.title || "Study Material";
  const amount = purchase.amount || "0";
  const asset = purchase.asset || "XLM";
  const purchaseId = String(purchase._id || purchase.purchaseId || "N/A");
  const dateStr = new Date(purchase.purchasedAt || purchase.confirmedAt || new Date()).toLocaleString();

  const subject = `Receipt for your purchase: ${title}`;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const downloadUrl = `${appUrl}/dashboard/my-materials`;

  const text = `Hi,\n\nThank you for your purchase on EduVault!\n\nHere is your receipt:\n- Material: ${title}\n- Amount: ${amount} ${asset}\n- Purchase ID: ${purchaseId}\n- Date: ${dateStr}\n\nYou can access and download your purchased material from your dashboard:\n${downloadUrl}\n\nCheers,\nEduVault Team`;

  const html = `
  <!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <title>Purchase Receipt</title>
    </head>
    <body style="margin:0;padding:0;background:#f6f9fc;font-family:sans-serif;">
      <div style="max-width:600px;margin:20px auto;padding:20px;background:#ffffff;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,0.06);">
        <h1 style="color:#111827;font-size:22px;margin-bottom:20px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">Purchase Receipt</h1>
        <p style="font-size:14px;color:#4b5563;line-height:1.5;">Thank you for your purchase on EduVault!</p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px;">
          <tr style="border-bottom:1px solid #e5e7eb;">
            <td style="padding:10px 0;font-weight:bold;color:#4b5563;">Material:</td>
            <td style="padding:10px 0;text-align:right;color:#111827;">${title}</td>
          </tr>
          <tr style="border-bottom:1px solid #e5e7eb;">
            <td style="padding:10px 0;font-weight:bold;color:#4b5563;">Amount:</td>
            <td style="padding:10px 0;text-align:right;color:#111827;">${amount} ${asset}</td>
          </tr>
          <tr style="border-bottom:1px solid #e5e7eb;">
            <td style="padding:10px 0;font-weight:bold;color:#4b5563;">Purchase ID:</td>
            <td style="padding:10px 0;text-align:right;color:#111827;font-family:monospace;">${purchaseId}</td>
          </tr>
          <tr style="border-bottom:1px solid #e5e7eb;">
            <td style="padding:10px 0;font-weight:bold;color:#4b5563;">Date:</td>
            <td style="padding:10px 0;text-align:right;color:#111827;">${dateStr}</td>
          </tr>
        </table>
        <div style="margin:30px 0;text-align:center;">
          <a href="${downloadUrl}" style="background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;display:inline-block;font-size:14px;">Access Purchased Material</a>
        </div>
        <p style="color:#9ca3af;font-size:12px;text-align:center;margin-top:20px;">© ${new Date().getFullYear()} EduVault</p>
      </div>
    </body>
  </html>`;

  await transporter.sendMail({ from, to, subject, text, html });
}

import { enqueueSideEffect } from '@/lib/backend/outbox';

export async function sendReceiptIfEligible(db, purchaseId) {
  try {
    const purchase = await db.collection('purchases').findOne({ _id: new ObjectId(String(purchaseId)) });
    if (!purchase) return;
    if (purchase.receiptSent) return;
    if (!['confirmed', 'settled', 'completed'].includes(purchase.status)) return;

    let email = purchase.userEmail;
    if (!email && purchase.buyerAddress) {
      const user = await db.collection('users').findOne({
        $or: [
          { walletAddress: purchase.buyerAddress },
          { walletAddressLower: purchase.buyerAddress.toLowerCase() }
        ]
      });
      email = user?.email;
    }

    if (!email) return;

    const material = await db.collection('materials').findOne({
      $or: [
        { materialId: purchase.materialId },
        { _id: ObjectId.isValid(purchase.materialId) ? new ObjectId(String(purchase.materialId)) : null }
      ].filter(Boolean)
    });
    if (!material) return;

    await enqueueSideEffect({
      sourceAggregate: 'purchase',
      sourceId: String(purchase._id),
      intent: {
        type: 'email',
        channel: 'purchase_receipt',
        payload: { email, purchase, material },
      },
    });

    await db.collection('purchases').updateOne(
      { _id: purchase._id },
      { $set: { receiptSent: true } }
    );
  } catch (err) {
    console.error('Failed to enqueue receipt email:', err);
  }
}

