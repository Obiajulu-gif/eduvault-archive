import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const WALLET = "GBBD47IF6LWK7P7MDEVSCWRZDPOVPOFWLYERWFBN4JSE3OUQTISLV5EX";

const stub = (code) => `data:text/javascript,${encodeURIComponent(code.trim())}`;

const modules = {
  "next/server": stub(`
    export const NextResponse = {
      json(body, init = {}) {
        const response = new Response(JSON.stringify(body), {
          status: init.status ?? 200,
          headers: { "content-type": "application/json" },
        });
        response.cookies = {
          values: [],
          set(name, value, options) {
            this.values.push({ name, value, options });
          },
        };
        return response;
      },
    };
  `),
  "@/lib/api/auth": stub(`
    export async function getUserFromCookie() {
      return globalThis.__profileTest.sessionUser ?? null;
    }
    export function sanitizeString(value, { maxLength = 5000 } = {}) {
      if (value === undefined || value === null) return "";
      return String(value).trim().slice(0, maxLength);
    }
  `),
  "@/lib/api/hardening": stub(`
    export async function withApiHardening(request, options, handler) {
      return handler();
    }
  `),
  "@/lib/api/audit": stub(`
    export function auditLog(entry) {
      globalThis.__profileTest.audits.push(entry);
    }
  `),
  "@/lib/mongodb": stub(`
    export async function getDb() {
      return globalThis.__profileTest.db;
    }
    export default { db: () => globalThis.__profileTest.db };
  `),
  "@/lib/auth/challenge": stub(`
    export async function verifyChallenge(address, nonce, signedTransactionXdr, options) {
      const test = globalThis.__profileTest;
      test.challengeCalls.push({ address, nonce, signedTransactionXdr, options });
      return test.proof;
    }
  `),
  "@/lib/email": stub(`
    export async function sendWelcomeEmail() {}
  `),
};

const srcRoot = path.resolve("src");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.prototype.hasOwnProperty.call(modules, specifier)) {
      return { url: modules[specifier], shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const relative = specifier.slice(2);
      const candidates = [relative, `${relative}.js`, path.join(relative, "index.js")];
      for (const candidate of candidates) {
        const absolute = path.join(srcRoot, candidate);
        if (existsSync(absolute)) {
          return { url: pathToFileURL(absolute).href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const profileRoute = await import("../../src/app/api/profile/route.js");
const exportRoute = await import("../../src/app/api/profile/export/route.js");

function applyUpdate(document, update = {}) {
  for (const [field, value] of Object.entries(update.$set || {})) {
    document[field] = value;
  }
  for (const field of Object.keys(update.$unset || {})) {
    delete document[field];
  }
}

function createDb(state) {
  return {
    collection(name) {
      return {
        async findOne(query) {
          state.queries.push({ name, query });
          if (name === "users") return state.userDoc;
          return null;
        },
        find(query) {
          state.queries.push({ name, query });
          return {
            async toArray() {
              return state.findResults[name] || [];
            },
          };
        },
        async updateOne(query, update) {
          state.updates.push({ name, query, update });
          if (name === "users") applyUpdate(state.userDoc, update);
          return { matchedCount: 1, modifiedCount: 1 };
        },
        async updateMany(query, update) {
          state.updates.push({ name, query, update });
          for (const document of state.findResults[name] || []) {
            applyUpdate(document, update);
          }
          return { modifiedCount: (state.findResults[name] || []).length };
        },
        async deleteMany(query) {
          state.deletions.push({ name, query });
        },
      };
    },
  };
}

function makeRequest(path, { method = "GET", body } = {}) {
  const init = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, init);
}

beforeEach(() => {
  const state = {
    sessionUser: { sub: "u1", walletAddress: WALLET },
    userDoc: {
      _id: "u1",
      sub: "u1",
      walletAddress: WALLET,
      walletAddressLower: WALLET.toLowerCase(),
      email: "creator@example.com",
      fullName: "Creator One",
      displayName: "Creator",
      bio: "Personal biography",
      twitterUrl: "https://twitter.com/creator",
      notificationPreferences: { reminders: false },
    },
    proof: { valid: true },
    challengeCalls: [],
    queries: [],
    updates: [],
    deletions: [],
    audits: [],
    findResults: {
      purchases: [{ _id: "p1", buyerAddress: WALLET, amount: "10" }],
      learner_notes: [{ _id: "n1", walletAddress: WALLET.toLowerCase(), note: "Study note" }],
      saved_materials: [{ _id: "s1", walletAddress: WALLET.toLowerCase(), materialId: "m1" }],
      reviews: [{ _id: "r1", reviewerAddress: WALLET, rating: 5, comment: "Great" }],
      material_feedback: [{ _id: "f1", reviewerAddress: WALLET.toLowerCase(), score: 4, comment: "Useful" }],
    },
  };
  state.db = createDb(state);
  globalThis.__profileTest = state;
});

describe("profile data rights routes", () => {
  describe("GET /api/profile/export", () => {
    it("requires authentication", async () => {
      globalThis.__profileTest.sessionUser = null;
      const response = await exportRoute.GET(makeRequest("/api/profile/export"));
      assert.equal(response.status, 401);
    });

    it("includes every user-owned collection in the archive", async () => {
      const response = await exportRoute.GET(makeRequest("/api/profile/export"));
      assert.equal(response.status, 200);
      const archive = await response.json();

      assert.equal(archive.format, "eduvault.profile-export.v1");
      assert.equal(archive.profile.email, "creator@example.com");
      assert.equal(archive.purchases.length, 1);
      assert.equal(archive.notes.length, 1);
      assert.equal(archive.savedItems.length, 1);
      assert.equal(archive.reviews.length, 1);
      assert.equal(archive.feedback.length, 1);
      assert.match(response.headers.get("content-disposition"), /attachment/);

      const queried = globalThis.__profileTest.queries.map((entry) => entry.name);
      for (const name of ["users", "purchases", "learner_notes", "saved_materials", "reviews", "material_feedback"]) {
        assert.ok(queried.includes(name), `${name} was not queried`);
      }
    });
  });

  describe("DELETE /api/profile", () => {
    it("requires authentication", async () => {
      globalThis.__profileTest.sessionUser = null;
      const response = await profileRoute.DELETE(
        makeRequest("/api/profile", {
          method: "DELETE",
          body: { address: WALLET, nonce: "nonce", signedTransactionXdr: "xdr" },
        })
      );
      assert.equal(response.status, 401);
    });

    it("validates the deletion request", async () => {
      const response = await profileRoute.DELETE(
        makeRequest("/api/profile", { method: "DELETE", body: { address: WALLET } })
      );
      assert.equal(response.status, 400);
      assert.equal(globalThis.__profileTest.challengeCalls.length, 0);
    });

    it("requires a fresh, valid wallet signature", async () => {
      globalThis.__profileTest.proof = { valid: false, reason: "Challenge expired" };
      const response = await profileRoute.DELETE(
        makeRequest("/api/profile", {
          method: "DELETE",
          body: { address: WALLET, nonce: "nonce", signedTransactionXdr: "xdr" },
        })
      );
      assert.equal(response.status, 403);
      assert.equal((await response.json()).reason, "Challenge expired");
      assert.equal(globalThis.__profileTest.updates.length, 0);
      assert.equal(globalThis.__profileTest.challengeCalls[0].options.action, "delete_profile");
    });

    it("anonymises PII, reviews and sessions while keeping profile records", async () => {
      const response = await profileRoute.DELETE(
        makeRequest("/api/profile", {
          method: "DELETE",
          body: { address: WALLET, nonce: "nonce", signedTransactionXdr: "xdr" },
        })
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.success, true);
      assert.equal(body.financialRecordsRetained, true);

      const user = globalThis.__profileTest.userDoc;
      assert.equal(user.email, "deleted-u1@deleted.eduvault.invalid");
      assert.equal(user.fullName, "Deleted user");
      assert.equal(user.bio, undefined);
      assert.equal(user.twitterUrl, undefined);
      assert.equal(user.walletAddressLower, undefined);
      assert.equal(user.status, "deleted");
      assert.ok(user.deletedAt);

      const anonymousUpdates = globalThis.__profileTest.updates.filter(
        (entry) => entry.name === "reviews" || entry.name === "material_feedback"
      );
      assert.equal(anonymousUpdates.length, 2);
      for (const document of globalThis.__profileTest.findResults.reviews) {
        assert.equal(document.reviewerAddress, null);
        assert.equal(document.anonymized, true);
        assert.equal(document.comment, "Great");
      }

      const refreshDeletion = globalThis.__profileTest.deletions.find(
        (entry) => entry.name === "refresh_tokens"
      );
      assert.ok(refreshDeletion);
      assert.ok(refreshDeletion.query.userId.$in.includes("u1"));
      assert.ok(refreshDeletion.query.userId.$in.includes(WALLET));
    });
  });
});
