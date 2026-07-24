import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  Account, Asset, Keypair, Networks, Operation, StrKey, TransactionBuilder, nativeToScVal,
} from "@stellar/stellar-sdk";
import {
  applyBrowserSecurityHeaders, buildContentSecurityPolicy, createCspNonce,
  normalizeCspReport, shouldRecordCspReport,
} from "../../src/lib/security/csp.js";
import {
  contentDispositionAttachment, normalizeExternalUrl, normalizePlainText,
  normalizeRedirectPath, normalizeRemoteImageUrl,
} from "../../src/lib/security/input.js";
import { verifyWalletTransactionIntent } from "../../src/lib/wallet/intent.js";

function xdr(source, operation) {
  return new TransactionBuilder(new Account(source, "1"), {
    fee: "100", networkPassphrase: Networks.TESTNET,
  }).addOperation(operation).setTimeout(30).build().toXDR();
}

test("strict CSP uses unique nonces and required browser headers", () => {
  const nonces = new Set(Array.from({ length: 16 }, createCspNonce));
  const csp = buildContentSecurityPolicy([...nonces][0], { development: false });
  assert.equal(nonces.size, 16);
  assert.match(csp, /script-src 'self' 'nonce-[a-f0-9]{32}' 'strict-dynamic'/);
  assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline|cdn\.jsdelivr\.net/);
  for (const rule of ["frame-src 'none'", "form-action 'self'", "require-trusted-types-for 'script'", "trusted-types nextjs nextjs#bundler"]) {
    assert.ok(csp.includes(rule));
  }

  const headers = applyBrowserSecurityHeaders(new Response(), { csp }).headers;
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("cross-origin-opener-policy"), "same-origin-allow-popups");
  assert.equal(headers.get("cross-origin-embedder-policy"), "credentialless");
  assert.equal(headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.match(headers.get("strict-transport-security"), /includeSubDomains/);
});

test("untrusted text, URLs, SVG, redirects, and filenames are normalized", () => {
  assert.equal(normalizePlainText("<img src=x onerror=alert(1)>"), "＜img src=x onerror=alert(1)＞");
  assert.throws(() => normalizeExternalUrl("javascript:alert(1)"), /HTTPS/);
  assert.throws(() => normalizeExternalUrl("https://127.0.0.1/private"), /public/);
  assert.throws(() => normalizeRemoteImageUrl("https://evil.example/a.png"), /allowlisted/);
  assert.throws(() => normalizeRemoteImageUrl("https://ipfs.io/a.svg"), /SVG/);
  assert.equal(normalizeRedirectPath("//evil.example/steal"), "/");
  assert.equal(normalizeRedirectPath("/dashboard?tab=purchases"), "/dashboard?tab=purchases");
  assert.doesNotMatch(contentDispositionAttachment("report\r\nX-Test: yes.pdf"), /[\r\n]/);
});

test("CSP reports remove secrets, sample, and deduplicate", () => {
  const report = normalizeCspReport({ "csp-report": {
    "effective-directive": "script-src-elem",
    "blocked-uri": "https://evil.example/a.js?token=secret#fragment",
    "document-uri": "https://eduvault.example/marketplace?email=user@example.com",
  } });
  assert.equal(report.blockedUrl, "https://evil.example/a.js");
  assert.equal(report.documentUrl, "https://eduvault.example/marketplace");
  assert.equal(shouldRecordCspReport(report, { sampleRate: 1, random: () => 0 }), true);
  assert.equal(shouldRecordCspReport(report, { sampleRate: 1, random: () => 0 }), false);
});

test("payment intent rejects network and amount mismatches", () => {
  const source = Keypair.random();
  const destination = Keypair.random();
  const transaction = xdr(source.publicKey(), Operation.payment({
    destination: destination.publicKey(), asset: Asset.native(), amount: "3.5000000",
  }));
  const intent = {
    summary: "Pay for material", networkPassphrase: Networks.TESTNET,
    operation: "payment", destination: destination.publicKey(), amount: "3.5", asset: "XLM",
  };
  const verify = (overrides = {}) => verifyWalletTransactionIntent({
    xdr: transaction, address: source.publicKey(), networkPassphrase: Networks.TESTNET,
    intent: { ...intent, ...overrides },
  });
  assert.equal(verify().operation, "payment");
  assert.throws(() => verify({ amount: "4" }), /amount/);
  assert.throws(() => verify({ networkPassphrase: Networks.PUBLIC }), /network/);
});

test("contract intent rejects contract and atomic amount mismatches", () => {
  const source = Keypair.random();
  const contractId = StrKey.encodeContract(randomBytes(32));
  const transaction = xdr(source.publicKey(), Operation.invokeContractFunction({
    contract: contractId, function: "purchase",
    args: [nativeToScVal(12500000n, { type: "i128" })],
  }));
  const intent = {
    summary: "Purchase material", networkPassphrase: Networks.TESTNET,
    operation: "invokeHostFunction", contractId, functionName: "purchase",
    amount: "12500000", amountArgIndex: 0,
  };
  const verify = (overrides = {}) => verifyWalletTransactionIntent({
    xdr: transaction, address: source.publicKey(), networkPassphrase: Networks.TESTNET,
    intent: { ...intent, ...overrides },
  });
  assert.equal(verify().operation, "invokeHostFunction");
  assert.throws(() => verify({ contractId: StrKey.encodeContract(randomBytes(32)) }), /contract/);
  assert.throws(() => verify({ amount: "1" }), /amount/);
});
