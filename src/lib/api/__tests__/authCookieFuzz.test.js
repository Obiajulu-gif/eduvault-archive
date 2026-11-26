// @vitest-environment node
/**
 * Authorization-path fuzzing for the shared session helpers (#1147).
 *
 * Lives under vitest rather than tests/backend/fuzz.test.mjs because
 * src/lib/api/auth.js imports through the `@/` alias, which `tsx --test`
 * does not resolve. The corpus is shared: FUZZ_AUTH_COOKIES in fuzzCorpus.js.
 *
 * Invariants for every fuzz cookie plus expired, wrong-secret, wrong-algorithm,
 * missing-sub and tampered tokens:
 *   - the helpers never throw (a throw here is an HTTP 500 instead of a 401);
 *   - nothing authenticates (fail closed);
 *   - a correctly signed token still authenticates (normal path).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import jwt from "jsonwebtoken";

// test/setup.js mocks this module globally; the fuzz targets are the real helpers.
vi.mock("@/lib/api/auth", async (importOriginal) => importOriginal());

import { getUserFromCookie, requireActiveUser, requireAdmin } from "@/lib/api/auth";
import { FUZZ_AUTH_COOKIES } from "@/lib/api/fuzzCorpus";

const SECRET = "fuzz-test-secret-0123456789";

// The helpers only read request.headers.get("cookie"); a stub lets the corpus
// include header values a real Headers object would refuse (CRLF).
const requestWith = (cookie) => ({
  headers: { get: (name) => (name.toLowerCase() === "cookie" ? cookie : null) },
});
const label = (cookie) => JSON.stringify(cookie).slice(0, 80);

let valid;
let corpus;

beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
  valid = jwt.sign({ sub: "user-1" }, SECRET, { expiresIn: "1h" });
  const [validHeader, , validSignature] = valid.split(".");
  const adminPayload = Buffer.from(JSON.stringify({ sub: "admin", role: "admin" })).toString("base64url");
  corpus = [
    ...FUZZ_AUTH_COOKIES,
    `auth_token=${jwt.sign({ sub: "user-1", exp: Math.floor(Date.now() / 1000) - 60 }, SECRET)}`, // expired
    `auth_token=${jwt.sign({ sub: "user-1" }, "a-different-secret")}`,                           // wrong secret
    `auth_token=${jwt.sign({ role: "admin" }, SECRET)}`,                                          // no sub
    `auth_token=${jwt.sign({ sub: "   " }, SECRET)}`,                                             // blank sub
    `auth_token=${jwt.sign({ sub: "user-1" }, SECRET, { algorithm: "HS512" })}`,                 // wrong alg
    `auth_token=${validHeader}.${adminPayload}.${validSignature}`,                                // tampered payload
  ];
});

describe("fuzz: session cookies — authorization path (#1147)", () => {
  it("normal: a correctly signed token authenticates, plain or percent-encoded", async () => {
    expect((await getUserFromCookie(requestWith(`auth_token=${valid}`)))?.sub).toBe("user-1");
    expect((await getUserFromCookie(requestWith(`theme=dark; auth_token=${encodeURIComponent(valid)}`)))?.sub).toBe("user-1");
  });

  it("getUserFromCookie never throws and never authenticates a fuzz cookie", async () => {
    for (const cookie of corpus) {
      await expect(getUserFromCookie(requestWith(cookie)), label(cookie)).resolves.toBeNull();
    }
  });

  it("requireActiveUser fails closed with 401 for every fuzz cookie", async () => {
    for (const cookie of corpus) {
      await expect(requireActiveUser(requestWith(cookie)), label(cookie)).resolves.toEqual({ ok: false, status: 401 });
    }
  });

  it("requireAdmin returns no user for every fuzz cookie", async () => {
    for (const cookie of corpus) {
      await expect(requireAdmin(requestWith(cookie)), label(cookie)).resolves.toBeNull();
    }
  });
});
