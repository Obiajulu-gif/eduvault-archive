import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  CORRELATION_HEADERS,
  correlationHeaders,
  correlatedFetch,
  createCorrelatedFetch,
  extractCorrelationId,
  generateCorrelationId,
  withCorrelationId,
} from "../correlationId.js";
import { runWithCorrelationId, getCorrelationId } from "../../monitoring/telemetry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHeaders(obj) {
  return new Headers(obj);
}

function makeRequest(headers = {}, url = "https://example.com/api/test") {
  return new Request(url, { headers });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// extractCorrelationId
// ---------------------------------------------------------------------------

describe("extractCorrelationId", () => {
  it("reads x-correlation-id", () => {
    const id = extractCorrelationId(makeHeaders({ "x-correlation-id": "abc-123" }));
    expect(id).toBe("abc-123");
  });

  it("falls back to x-request-id when x-correlation-id is absent", () => {
    const id = extractCorrelationId(makeHeaders({ "x-request-id": "req-456" }));
    expect(id).toBe("req-456");
  });

  it("extracts trace-id from traceparent", () => {
    const id = extractCorrelationId(
      makeHeaders({ traceparent: "00-abc123def456abc123-spanspanspan-01" })
    );
    expect(id).toBe("abc123def456abc123");
  });

  it("returns undefined when no recognized header is present", () => {
    expect(extractCorrelationId(makeHeaders({}))).toBeUndefined();
  });

  it("returns undefined for null input", () => {
    expect(extractCorrelationId(null)).toBeUndefined();
  });

  it("strips values longer than 128 chars", () => {
    const long = "a".repeat(200);
    // Should still be treated as valid (trimmed to 128)
    const result = extractCorrelationId(makeHeaders({ "x-correlation-id": long }));
    expect(result?.length).toBeLessThanOrEqual(128);
  });
});

// ---------------------------------------------------------------------------
// generateCorrelationId
// ---------------------------------------------------------------------------

describe("generateCorrelationId", () => {
  it("returns a UUID-shaped string", () => {
    const id = generateCorrelationId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("produces unique values on each call", () => {
    expect(generateCorrelationId()).not.toBe(generateCorrelationId());
  });
});

// ---------------------------------------------------------------------------
// correlationHeaders
// ---------------------------------------------------------------------------

describe("correlationHeaders", () => {
  it("sets the correlation ID header", () => {
    const headers = correlationHeaders("my-id");
    expect(headers[CORRELATION_HEADERS.CORRELATION_ID]).toBe("my-id");
  });

  it("merges base headers", () => {
    const headers = correlationHeaders("my-id", { "content-type": "application/json" });
    expect(headers["content-type"]).toBe("application/json");
    expect(headers[CORRELATION_HEADERS.CORRELATION_ID]).toBe("my-id");
  });
});

// ---------------------------------------------------------------------------
// withCorrelationId middleware
// ---------------------------------------------------------------------------

describe("withCorrelationId", () => {
  it("propagates an inbound correlation ID to the response header", async () => {
    const handler = async () => jsonResponse({ ok: true });
    const wrapped = withCorrelationId(handler);

    const req = makeRequest({ "x-correlation-id": "inbound-id-001" });
    const res = await wrapped(req);

    expect(res.headers.get("x-correlation-id")).toBe("inbound-id-001");
  });

  it("generates a new correlation ID when none is supplied", async () => {
    const handler = async () => jsonResponse({ ok: true });
    const wrapped = withCorrelationId(handler);

    const req = makeRequest();
    const res = await wrapped(req);
    const id = res.headers.get("x-correlation-id");

    expect(id).toBeTruthy();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("makes the correlation ID available inside the handler via getCorrelationId", async () => {
    let ambientId;
    const handler = async () => {
      ambientId = getCorrelationId();
      return jsonResponse({ ok: true });
    };
    const wrapped = withCorrelationId(handler);

    const req = makeRequest({ "x-correlation-id": "test-ambient-123" });
    const res = await wrapped(req);

    expect(ambientId).toBe("test-ambient-123");
    expect(res.headers.get("x-correlation-id")).toBe("test-ambient-123");
  });

  it("preserves the original response status", async () => {
    const handler = async () => new Response("not found", { status: 404 });
    const wrapped = withCorrelationId(handler);

    const res = await wrapped(makeRequest());
    expect(res.status).toBe(404);
    expect(res.headers.get("x-correlation-id")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// correlatedFetch
// ---------------------------------------------------------------------------

describe("correlatedFetch", () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: true }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("injects the ambient correlation ID into outgoing fetch requests", async () => {
    await runWithCorrelationId("ambient-456", async () => {
      await correlatedFetch("https://example.com/downstream");
    });

    const [, init] = fetchSpy.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get("x-correlation-id")).toBe("ambient-456");
  });

  it("falls back to plain fetch when no ambient ID exists", async () => {
    await correlatedFetch("https://example.com/no-ambient");
    expect(fetchSpy).toHaveBeenCalledOnce();
    // Should not throw even without ambient context
  });

  it("does not overwrite an existing correlation ID header", async () => {
    await runWithCorrelationId("ambient-id", async () => {
      await correlatedFetch("https://example.com/downstream", {
        headers: { "x-correlation-id": "caller-supplied" },
      });
    });

    const [, init] = fetchSpy.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get("x-correlation-id")).toBe("caller-supplied");
  });
});

// ---------------------------------------------------------------------------
// createCorrelatedFetch
// ---------------------------------------------------------------------------

describe("createCorrelatedFetch", () => {
  it("always sends the bound correlation ID", async () => {
    const calls = [];
    const mockFetch = async (url, init) => {
      calls.push({ url, headers: new Headers(init.headers) });
      return jsonResponse({ ok: true });
    };

    const fetch = createCorrelatedFetch("bound-id-789", mockFetch);
    await fetch("https://example.com/api");

    expect(calls[0].headers.get("x-correlation-id")).toBe("bound-id-789");
  });

  it("throws when correlationId is missing", () => {
    expect(() => createCorrelatedFetch(undefined)).toThrow(TypeError);
  });

  it("does not overwrite a caller-supplied header", async () => {
    const calls = [];
    const mockFetch = async (url, init) => {
      calls.push(new Headers(init.headers));
      return jsonResponse({ ok: true });
    };

    const fetch = createCorrelatedFetch("bound-id", mockFetch);
    await fetch("https://example.com/api", {
      headers: { "x-correlation-id": "caller-id" },
    });

    expect(calls[0].get("x-correlation-id")).toBe("caller-id");
  });
});
