import crypto from 'node:crypto';

export function generateEventId() {
  return crypto.randomUUID();
}

export function createWebhookPayload(eventId, eventType, data) {
  return {
    id: eventId,
    type: eventType,
    created: new Date().toISOString(),
    data: data,
  };
}

export function generateSignature(payloadStr, secret, timestamp) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${timestamp}.${payloadStr}`);
  return `v1=${hmac.digest('hex')}`;
}

export function generateSignaturesHeader(payloadStr, secrets) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signatures = secrets.map(secret => generateSignature(payloadStr, secret.key, timestamp));
  return `t=${timestamp},${signatures.join(',')}`;
}

export function verifySignature(payloadStr, signatureHeader, secret) {
  if (!signatureHeader) return false;

  const parts = signatureHeader.split(',');
  let timestamp;
  const signatures = [];

  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 't') {
      timestamp = value;
    } else if (key === 'v1') {
      signatures.push(value);
    }
  }

  if (!timestamp || signatures.length === 0) return false;

  // Prevent replay attacks (e.g., 5 minute tolerance)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 5 * 60) {
    return false;
  }

  const expectedSignature = generateSignature(payloadStr, secret, timestamp).split('=')[1];
  const expectedBuffer = Buffer.from(expectedSignature);

  for (const sig of signatures) {
    const sigBuffer = Buffer.from(sig);
    if (sigBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      return true;
    }
  }

  return false;
}
