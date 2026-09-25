/**
 * Forked entry point for the preview sandbox (#638).
 *
 * Runs with `--experimental-permission` (no fs-write, no child_process, no
 * worker, no addons) and `--allow-fs-read` scoped to this directory. The very
 * first thing it does is close network egress in userland (`lockdown.mjs`) and
 * scrub the environment, then it waits for one job over IPC, runs the named
 * previewer, returns the descriptor, and exits.
 *
 * Built-ins + this directory only.
 */

import { applyLockdown } from "./lockdown.mjs";

applyLockdown();

// Nothing in a preview parser needs the ambient environment; leave only what
// Node itself may consult so no secret is observable from inside the sandbox.
const ENV_ALLOW = new Set(["NODE_ENV", "LANG", "LC_ALL", "TZ", "PATH"]);
for (const key of Object.keys(process.env)) {
  if (!ENV_ALLOW.has(key)) delete process.env[key];
}

// Previewers are addressed by name, never by path, so a job can't point the
// dynamic import anywhere else.
const PREVIEWERS = new Set(["structuralPreview"]);

function fail(reason) {
  send({ ok: false, reason: String(reason).slice(0, 500) });
  process.exit(0);
}

function send(msg) {
  try {
    process.send?.(msg);
  } catch {
    /* parent gone — exit path below still runs */
  }
}

process.once("message", async (job) => {
  try {
    const { input, mimeType, limits, previewer } = job || {};
    if (!PREVIEWERS.has(previewer)) return fail(`unknown previewer: ${previewer}`);
    if (!input || !(input instanceof Uint8Array)) return fail("missing or invalid input buffer");

    const mod = await import(`./previewers/${previewer}.mjs`);
    const run = mod.generatePreview || mod.default;
    if (typeof run !== "function") return fail("previewer has no generatePreview export");

    const preview = run({ input: Buffer.from(input), mimeType: mimeType || "", limits: limits || {} });
    send({ ok: true, preview, previewerVersion: mod.PREVIEWER_VERSION || previewer });
  } catch (err) {
    return fail(err?.message || err);
  }
  process.exit(0);
});

// If the parent never sends a job, don't linger.
setTimeout(() => process.exit(0), 30_000).unref();
