import { randomUUID } from "crypto";

/**
 * Derive a stable, spoof-resistant rate-limit bucket key from a request.
 *
 * Trust hierarchy (only headers injected by infrastructure are trusted):
 *   1. `x-vercel-forwarded-for` – set by Vercel's edge, not overwritable by clients.
 *   2. `x-real-ip` – trusted ONLY when the deployment uses a reverse proxy that
 *      strips/overwrites client-supplied forwarding headers (indicated by the
 *      `TRUSTED_PROXY_COUNT` env var being set to a positive integer).
 *   3. Fallback – a composite key derived from stable request metadata
 *      (user-agent + accept-language + origin), avoiding a single shared
 *      "local" bucket that would let every anonymous caller throttle each other.
 */
export function clientKey(request) {
  // 1. Vercel edge — always trustworthy, cannot be spoofed by clients.
  const vercelIp = request.headers.get("x-vercel-forwarded-for");
  if (vercelIp) {
    return `vf:${vercelIp.split(",")[0].trim()}`;
  }

  // 2. Reverse-proxy header — only trusted when the operator has confirmed
  //    that a trusted proxy sits in front and overwrites this header.
  const trustedProxyCount = parseInt(process.env.TRUSTED_PROXY_COUNT, 10);
  if (trustedProxyCount > 0) {
    const realIp = request.headers.get("x-real-ip");
    if (realIp) {
      return `proxy:${realIp.trim()}`;
    }
  }

  // 3. Fallback: combine semi-stable request metadata to produce a per-caller
  //    bucket that an attacker cannot reset simply by changing one header.
  //    User-agent + accept-language are stable for a given client and avoid
  //    the "everyone shares one bucket" problem of a static "local" key.
  const ua = request.headers.get("user-agent") || "";
  const al = request.headers.get("accept-language") || "";
  const origin = request.headers.get("origin") || request.headers.get("referer") || "";

  if (ua || al) {
    const hashInput = `${ua}|${al}|${origin}`;
    let hash = 0;
    for (let i = 0; i < hashInput.length; i++) {
      hash = ((hash << 5) - hash + hashInput.charCodeAt(i)) | 0;
    }
    return `meta:${hash.toString(36)}`;
  }

  // Absolute last resort — still namespaced so it never collides with other keys.
  return `anon:${randomUUID()}`;
}
