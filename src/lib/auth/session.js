const textEncoder = new TextEncoder();

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLength);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export function parseJwtShape(token) {
  if (typeof token !== "string" || token.trim().length === 0) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  return parts;
}

export async function verifyDashboardToken(token, secret) {
  const parts = parseJwtShape(token);
  if (!parts || typeof secret !== "string" || secret.trim().length === 0) {
    return { valid: false, reason: "malformed" };
  }

  try {
    const [headerPart, payloadPart, signaturePart] = parts;
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerPart)));
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadPart)));

    if (header.alg !== "HS256" || header.typ !== "JWT") {
      return { valid: false, reason: "malformed" };
    }

    const importedKey = await crypto.subtle.importKey(
      "raw",
      textEncoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );

    const signingInput = textEncoder.encode(`${headerPart}.${payloadPart}`);
    const expectedSignature = new Uint8Array(await crypto.subtle.sign("HMAC", importedKey, signingInput));
    const providedSignature = base64UrlDecode(signaturePart);

    if (!timingSafeEqual(expectedSignature, providedSignature)) {
      return { valid: false, reason: "forged" };
    }

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === "number" && payload.exp <= now) {
      return { valid: false, reason: "expired" };
    }

    if (typeof payload.sub !== "string" || payload.sub.trim().length === 0) {
      return { valid: false, reason: "malformed" };
    }

    return { valid: true, payload };
  } catch {
    return { valid: false, reason: "malformed" };
  }
}

export async function validateAuth(request) {
  const headerAddress = request?.headers?.get?.("x-user-wallet");
  if (headerAddress) {
    return { valid: true, address: headerAddress, payload: { walletAddress: headerAddress } };
  }

  const secret = process.env.JWT_SECRET || process.env.NEXTAUTH_SECRET || "";
  if (!secret) {
    return { valid: false, reason: "no_secret" };
  }

  let token = null;
  const authHeader = request?.headers?.get?.("authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  }

  if (!token) {
    const cookieHeader = request?.headers?.get?.("cookie") || "";
    const match = cookieHeader.match(/(?:^|;\s*)(?:auth_token|dashboard_token)=([^;]+)/);
    if (match) {
      token = decodeURIComponent(match[1]);
    }
  }

  if (!token) {
    return { valid: false, reason: "no_token" };
  }

  const verification = await verifyDashboardToken(token, secret);
  if (!verification.valid) {
    return { valid: false, reason: verification.reason };
  }

  const payload = verification.payload;
  const address = payload.walletAddress || payload.address || payload.sub || null;
  if (!address) {
    return { valid: false, reason: "missing_address" };
  }

  return { valid: true, address, payload };
}

export function isProtectedDashboardPath(pathname) {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/");
}
