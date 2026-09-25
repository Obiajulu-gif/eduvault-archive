/**
 * Disposable sandbox for preview generation (#638).
 *
 * `runInPreviewSandbox` runs a named previewer over an attacker-controlled
 * buffer in a **forked, throwaway Node process** so a malformed or polyglot
 * file cannot escape, reach the network, exhaust memory, or hang a worker:
 *
 *   - `--experimental-permission` denies the fork filesystem writes,
 *     `child_process`, `worker_threads`, and native addons; `--allow-fs-read`
 *     is scoped to the sandbox code directory only.
 *   - `--max-old-space-size` caps the V8 heap (contained abort on OOM).
 *   - Network egress is closed in userland inside the child (`lockdown.mjs`) —
 *     the permission model has no network switch.
 *   - A wall-clock timeout hard-kills the process (`SIGKILL`).
 *   - Input (<=10 MB) and the serialized output descriptor are size-capped.
 *
 * It never throws for a previewer failure — every outcome is a typed result, so
 * callers stay fail-closed.
 *
 * Time/space: O(1) processes per call; CPU, heap, wall-time, input and output
 * are all bounded by `limits` regardless of input — the sandbox converts
 * "unbounded on hostile input" into "O(caps)".
 */

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SANDBOX_DIR = dirname(fileURLToPath(import.meta.url)) + "/previewSandbox";
const DEFAULT_CHILD_ENTRY = join(SANDBOX_DIR, "child.mjs");

// Resolved per call so tests (and deployments) can point at an alternate entry
// via the `childEntry` option or `PREVIEW_SANDBOX_CHILD`.
function resolveChildEntry(childEntry) {
  return childEntry || process.env.PREVIEW_SANDBOX_CHILD || DEFAULT_CHILD_ENTRY;
}

export const DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 10_000,
  heapMb: 128,
  maxInputBytes: 10 * 1024 * 1024,
  maxOutputBytes: 64 * 1024,
});

let permissionModelSupported = null;
function supportsPermissionModel() {
  if (permissionModelSupported === null) {
    const [major] = process.versions.node.split(".").map(Number);
    // `--experimental-permission` landed in 20.0; renamed to `--permission` in 22.
    permissionModelSupported = major >= 20;
  }
  return permissionModelSupported;
}

function buildExecArgv(limits, childEntry) {
  const argv = [`--max-old-space-size=${limits.heapMb}`, "--no-warnings", "--disable-proto=throw"];
  if (supportsPermissionModel()) {
    const flag = Number(process.versions.node.split(".")[0]) >= 22 ? "--permission" : "--experimental-permission";
    // Reads are confined to the sandbox code directory (lockdown, hooks,
    // previewers) plus the directory of the entry we were told to run.
    argv.push(flag, `--allow-fs-read=${SANDBOX_DIR}`);
    const entryDir = dirname(childEntry);
    if (entryDir !== SANDBOX_DIR) argv.push(`--allow-fs-read=${entryDir}`);
  }
  return argv;
}

/**
 * @param {object} args
 * @param {Buffer|Uint8Array} args.input      Raw file bytes.
 * @param {string} [args.mimeType]            Declared MIME (advisory only).
 * @param {string} [args.previewer]           Registered previewer name (default "structuralPreview").
 * @param {Partial<typeof DEFAULT_LIMITS>} [args.limits]
 * @returns {Promise<{ status: "ok"|"failed"|"timeout"|"rejected", preview?: object, previewerVersion?: string, reason?: string, durationMs: number, isolation: { permissionModel: boolean } }>}
 */
export async function runInPreviewSandbox({ input, mimeType = "", previewer = "structuralPreview", limits = {}, childEntry } = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const startedAt = Date.now();
  const isolation = { permissionModel: supportsPermissionModel() };

  const bytes = input instanceof Uint8Array ? input : Buffer.from(input || []);
  if (bytes.length === 0) {
    return { status: "failed", reason: "empty input", durationMs: 0, isolation };
  }
  if (bytes.length > L.maxInputBytes) {
    return { status: "rejected", reason: `input exceeds ${L.maxInputBytes} bytes`, durationMs: 0, isolation };
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.removeAllListeners();
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve({ ...result, durationMs: Date.now() - startedAt, isolation });
    };

    const entry = resolveChildEntry(childEntry);
    const child = fork(entry, [], {
      execArgv: buildExecArgv(L, entry),
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: {}, // the child scrubs anything anyway; start it empty
      detached: false,
    });

    const timer = setTimeout(() => {
      finish({ status: "timeout", reason: `previewer exceeded ${L.timeoutMs}ms` });
    }, L.timeoutMs);

    child.on("message", (msg) => {
      if (!msg || typeof msg !== "object") return finish({ status: "failed", reason: "malformed sandbox response" });
      if (msg.ok !== true) return finish({ status: "failed", reason: msg.reason || "previewer failed" });

      let serialized;
      try {
        serialized = JSON.stringify(msg.preview);
      } catch {
        return finish({ status: "failed", reason: "descriptor not serializable" });
      }
      if (!serialized || Buffer.byteLength(serialized) > L.maxOutputBytes) {
        return finish({ status: "rejected", reason: `descriptor exceeds ${L.maxOutputBytes} bytes` });
      }
      finish({ status: "ok", preview: msg.preview, previewerVersion: msg.previewerVersion });
    });

    child.on("error", (err) => finish({ status: "failed", reason: `sandbox error: ${err.message}` }));
    child.on("exit", (code, signal) => {
      finish({ status: "failed", reason: `sandbox exited early (code=${code} signal=${signal})` });
    });

    try {
      child.send({ input: bytes, mimeType, limits: L, previewer });
    } catch (err) {
      finish({ status: "failed", reason: `could not dispatch job: ${err.message}` });
    }
  });
}
