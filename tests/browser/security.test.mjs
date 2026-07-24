import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";

const baseUrl = "http://127.0.0.1:3100";

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(baseUrl)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Production server did not start");
}

test("production policy and reflected XSS protection work in Chrome", { timeout: 30_000 }, async () => {
  const server = spawn("npm", ["run", "start", "--", "--hostname", "127.0.0.1", "--port", "3100"], {
    detached: true, env: { ...process.env, CI: "true" }, stdio: "ignore",
  });
  try {
    await waitForServer();
    const [first, second] = await Promise.all([fetch(baseUrl), fetch(baseUrl)]);
    const csp = first.headers.get("content-security-policy") || "";
    assert.match(csp, /require-trusted-types-for 'script'/);
    assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline/);
    assert.notEqual(csp.match(/'nonce-([^']+)'/)?.[1], second.headers
      .get("content-security-policy")?.match(/'nonce-([^']+)'/)?.[1]);
    assert.equal(first.headers.get("x-frame-options"), "DENY");

    const chrome = [process.env.CHROME_PATH, "google-chrome", "chromium", "chromium-browser"]
      .filter(Boolean).find((bin) => spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0);
    assert.ok(chrome, "Chrome or Chromium is required");
    const payload = '<img id="xss-marker" src=x onerror="document.documentElement.dataset.pwned=1">';
    const result = spawnSync(chrome, [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--disable-background-networking", "--virtual-time-budget=5000", "--dump-dom",
      `${baseUrl}/marketplace?search=${encodeURIComponent(payload)}`,
    ], { encoding: "utf8", timeout: 25_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Marketplace/);
    assert.doesNotMatch(result.stdout, /<img id="xss-marker"|data-pwned="1"/);
  } finally {
    if (server.pid) process.kill(-server.pid, "SIGTERM");
  }
});
