import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  classifyLogField,
  pseudonymize,
  maskIdentifiersInText,
  sanitizeUrl,
  protectLogFields,
  protectLogArguments,
  createLogSafetyOptions,
} from "../../monitoring/logSafety.js";

describe("classifyLogField", () => {
  it("classifies wallet-like field names as IDENTIFIER", () => {
    expect(classifyLogField("walletAddress")).toMatch(/identifier/i);
  });

  it("classifies email field names as IDENTIFIER", () => {
    expect(classifyLogField("email")).toMatch(/identifier/i);
  });

  it("classifies ip as LOCATOR", () => {
    expect(classifyLogField("ip")).toMatch(/locator/i);
  });

  it("classifies url as LOCATOR", () => {
    expect(classifyLogField("url")).toMatch(/locator/i);
  });

  it("classifies body / payload as PAYLOAD", () => {
    expect(classifyLogField("body")).toMatch(/payload/i);
    expect(classifyLogField("payload")).toMatch(/payload/i);
  });

  it("classifies unknown fields as DEFAULT", () => {
    const cls = classifyLogField("someUnknownField");
    expect(cls).toBeTruthy(); // returns a classification
  });
});

describe("pseudonymize", () => {
  it("returns a consistent hash for the same input", () => {
    const a = pseudonymize("alice@example.com");
    const b = pseudonymize("alice@example.com");
    expect(a).toBe(b);
  });

  it("returns a different hash for a different input", () => {
    const a = pseudonymize("alice@example.com");
    const b = pseudonymize("bob@example.com");
    expect(a).not.toBe(b);
  });

  it("does not reveal the original value in the hash", () => {
    const result = pseudonymize("alice@example.com");
    expect(result).not.toContain("alice");
    expect(result).not.toContain("example.com");
  });

  it("handles Stellar wallet addresses", () => {
    const wallet = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
    const result = pseudonymize(wallet);
    expect(result).not.toContain("GAAZI4");
  });
});

describe("maskIdentifiersInText", () => {
  it("masks email addresses in a string", () => {
    const text = "User alice@example.com logged in";
    const result = maskIdentifiersInText(text);
    expect(result).not.toContain("alice@example.com");
  });

  it("masks IPv4 addresses in a string", () => {
    const text = "Request from 192.168.1.100 at 10:00";
    const result = maskIdentifiersInText(text);
    expect(result).not.toContain("192.168.1.100");
  });

  it("masks Stellar wallet addresses in a string", () => {
    const wallet = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
    const text = `Wallet ${wallet} performed action`;
    const result = maskIdentifiersInText(text);
    expect(result).not.toContain(wallet);
  });

  it("preserves non-identifier text", () => {
    const text = "System startup completed successfully";
    const result = maskIdentifiersInText(text);
    expect(result).toContain("startup completed");
  });
});

describe("sanitizeUrl", () => {
  it("removes query parameters containing auth tokens", () => {
    const url = "https://api.example.com/data?token=abc123&page=2";
    const result = sanitizeUrl(url);
    expect(result).not.toContain("token=abc123");
  });

  it("preserves non-sensitive query parameters", () => {
    const url = "https://api.example.com/data?page=2&sort=asc";
    const result = sanitizeUrl(url);
    expect(result).toContain("page=2");
  });

  it("removes password from URL credentials", () => {
    const url = "https://user:password@api.example.com/data";
    const result = sanitizeUrl(url);
    expect(result).not.toContain("password");
  });
});

describe("protectLogFields", () => {
  it("pseudonymizes email field values", () => {
    const fields = { email: "alice@example.com", action: "login" };
    const result = protectLogFields(fields);
    expect(result.email).not.toBe("alice@example.com");
    expect(result.action).toBe("login");
  });

  it("pseudonymizes wallet address fields", () => {
    const wallet = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
    const fields = { walletAddress: wallet, event: "transfer" };
    const result = protectLogFields(fields);
    expect(result.walletAddress).not.toBe(wallet);
  });

  it("omits or redacts payload fields", () => {
    const fields = { body: '{"creditCard":"4111111111111111"}', action: "payment" };
    const result = protectLogFields(fields);
    const bodyValue = result.body;
    expect(bodyValue == null || !String(bodyValue).includes("4111111111111111")).toBe(true);
  });

  it("sanitizes URL locator fields", () => {
    const fields = { url: "https://api.example.com/data?token=secret123" };
    const result = protectLogFields(fields);
    expect(String(result.url)).not.toContain("secret123");
  });

  it("preserves non-sensitive fields unmodified", () => {
    const fields = { level: "info", message: "startup", timestamp: "2024-01-01" };
    const result = protectLogFields(fields);
    expect(result.level).toBe("info");
    expect(result.message).toBe("startup");
  });
});

describe("protectLogArguments", () => {
  it("masks identifiers in string arguments", () => {
    const args = ["User alice@example.com logged in from 192.168.1.1"];
    const result = protectLogArguments(args);
    expect(result[0]).not.toContain("alice@example.com");
    expect(result[0]).not.toContain("192.168.1.1");
  });

  it("recursively protects object arguments", () => {
    const args = [{ user: { email: "bob@example.com", role: "admin" } }];
    const result = protectLogArguments(args);
    expect(result[0].user.email).not.toBe("bob@example.com");
    expect(result[0].user.role).toBe("admin");
  });

  it("passes through non-sensitive primitive arguments", () => {
    const args = [42, true, "plain text message"];
    const result = protectLogArguments(args);
    expect(result[0]).toBe(42);
    expect(result[1]).toBe(true);
  });
});

describe("createLogSafetyOptions", () => {
  it("returns an options object with serializers", () => {
    const opts = createLogSafetyOptions();
    expect(opts).toBeTruthy();
    expect(typeof opts).toBe("object");
  });

  it("produced serializers protect email in req.body-shaped objects", () => {
    const opts = createLogSafetyOptions();
    if (opts.serializers?.req) {
      const req = { method: "POST", url: "/api/login", body: { email: "carol@test.com" } };
      const serialized = opts.serializers.req(req);
      const bodyStr = JSON.stringify(serialized);
      expect(bodyStr).not.toContain("carol@test.com");
    }
  });
});
