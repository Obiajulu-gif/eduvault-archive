/**
 * In-process lockdown for the preview sandbox child (#638).
 *
 * The Node permission model (`--experimental-permission`, passed by the parent)
 * already denies this forked process filesystem *writes*, `child_process`
 * spawning, `worker_threads`, and native addons. It has **no network switch**
 * and loader hooks (`module.register`) need `--allow-worker`, which the sandbox
 * withholds. So network egress is closed here, in-thread, before any
 * attacker-influenced previewer code runs, by:
 *
 *   1. replacing the global fetch / WebSocket / XHR surface with throwing stubs;
 *   2. making CommonJS `require()` of a networking / process core module throw;
 *   3. eagerly loading each of those core modules and overwriting the methods
 *      that open a socket or spawn a process with throwers — Node caches core
 *      modules as singletons, so a later `import "node:net"` sees the same
 *      neutered object.
 *
 * Imports only Node built-ins and must stay that way — it runs with
 * `--allow-fs-read` scoped to this directory alone.
 *
 * Time/space: O(1) — a fixed set of property assignments.
 */

import Module from "node:module";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Core modules a preview parser has no legitimate need to import at all. */
export const BLOCKED_MODULES = Object.freeze([
  "net", "tls", "dns", "dns/promises", "dgram",
  "http", "https", "http2", "inspector", "inspector/promises",
  "child_process", "worker_threads", "cluster",
]);

const BLOCKED = new Set(BLOCKED_MODULES.flatMap((m) => [m, `node:${m}`]));

export function isBlockedModule(request) {
  return BLOCKED.has(request);
}

export function denyModule(name) {
  const err = new Error(`preview sandbox: "${name}" is blocked`);
  err.code = "ERR_PREVIEW_SANDBOX_BLOCKED";
  throw err;
}

// Which exported members of each core module to replace with a thrower. Loading
// the module and overwriting these is what actually stops an ESM
// `import("node:net")` — the require() hook below only covers CommonJS.
const NEUTRALIZE = {
  net: ["connect", "createConnection", "createServer"],
  tls: ["connect", "createServer"],
  dns: ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveMx", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"],
  "dns/promises": ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveMx", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"],
  dgram: ["createSocket"],
  http: ["request", "get", "createServer"],
  https: ["request", "get", "createServer"],
  http2: ["connect", "createServer", "createSecureServer"],
  child_process: ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"],
  inspector: ["open"],
};

let applied = false;

/** Apply the lockdown. Idempotent; call once, first thing, in the child. */
export function applyLockdown() {
  if (applied) return;
  applied = true;

  // 1. Global network primitives.
  const netStub = () => denyModule("fetch");
  for (const key of ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"]) {
    try {
      Object.defineProperty(globalThis, key, { configurable: false, writable: false, value: netStub });
    } catch {
      try {
        globalThis[key] = netStub;
      } catch {
        /* frozen already — the module neutralization below still holds */
      }
    }
  }

  // 2. Neutralize the core-module singletons FIRST — while `require` still
  //    works — so a later ESM `import("node:net")` sees the neutered object.
  //    (An ESM `import` of a builtin does not pass through the require hook
  //    installed in step 3, so this mutation is the real enforcement there.)
  for (const [name, members] of Object.entries(NEUTRALIZE)) {
    let mod;
    try {
      mod = require(`node:${name}`);
    } catch {
      continue;
    }
    const thrower = () => denyModule(name);
    for (const member of members) {
      try {
        if (member in mod) mod[member] = thrower;
      } catch {
        /* non-writable — skip; step 3 + permission model still apply */
      }
    }
    if (name === "net" && mod.Socket?.prototype) {
      try {
        mod.Socket.prototype.connect = thrower;
      } catch {
        /* ignore */
      }
    }
    if (name === "worker_threads") {
      try {
        mod.Worker = thrower;
      } catch {
        /* ignore */
      }
    }
  }

  // 3. CommonJS require() hook — a transitive dep doing require("net") never
  //    even gets the (already neutered) module back.
  const origLoad = Module._load;
  Module._load = function guardedLoad(request, parent, isMain) {
    if (isBlockedModule(request)) denyModule(request);
    return origLoad.call(this, request, parent, isMain);
  };
}
