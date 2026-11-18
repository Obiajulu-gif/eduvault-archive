#!/usr/bin/env node
/**
 * Contributor diagnostics.
 *
 *   npm run diagnostics:contributor                 dependency health (#1061)
 *   npm run diagnostics:contributor -- --json       same, as JSON
 *   npm run diagnostics:contributor -- --setup      local setup failures (#1079)
 *   npm run diagnostics:contributor -- --setup --offline   skip the MongoDB probe
 *
 * `--setup` exit codes: 0 ready, 1 action required, 75 retry later.
 * Without `--setup` the exit codes are unchanged: 1 only when misconfigured.
 */
import net from 'node:net';
import { runContributorDiagnostics } from '../src/lib/health/contributorDiagnostics.js';
import {
  buildSetupReport,
  checkLocalSetup,
  formatSetupReport,
  parseEnvFile,
  probeWithRetry,
} from '../src/lib/health/setupFailureDiagnostics.js';
import { existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const json = args.includes('--json');

function tcpProbe(host, port, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const done = (error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(timeoutMs, () => done(Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' })));
    socket.once('connect', () => done());
    socket.once('error', done);
  });
}

function mongoTarget(uri) {
  // Only plain mongodb:// URIs have a single host to probe; SRV records are
  // resolved by the driver and are left to the dependency check.
  const match = /^mongodb:\/\/(?:[^@/]+@)?([^/:,?]+)(?::(\d+))?/.exec(uri || '');
  return match ? { host: match[1], port: Number(match[2] || 27017) } : null;
}

async function runSetup() {
  const failures = checkLocalSetup({ rootDir: process.cwd(), env: process.env });
  const probes = [];
  if (!args.includes('--offline')) {
    const fileEnv = existsSync('.env.local') ? parseEnvFile(readFileSync('.env.local', 'utf8')) : {};
    const target = mongoTarget(process.env.MONGODB_URI || fileEnv.MONGODB_URI);
    if (target) probes.push(await probeWithRetry('mongodb', () => tcpProbe(target.host, target.port)));
  }
  const report = buildSetupReport({ failures, probes });
  console.log(json ? JSON.stringify(report, null, 2) : formatSetupReport(report));
  process.exit(report.exitCode);
}

try {
  if (args.includes('--setup')) {
    await runSetup();
  } else {
    const report = await runContributorDiagnostics();
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Contributor diagnostics: ${report.dependencyReport.status.toUpperCase()}`);
      console.log(`Node: ${report.runtime.node} (${report.runtime.platform}/${report.runtime.arch})`);
      for (const item of report.remediation) console.log(`- ${item.dependency}: ${item.hint}`);
    }
    process.exit(report.dependencyReport.status === 'misconfigured' ? 1 : 0);
  }
} catch (error) {
  console.error(`Contributor diagnostics failed: ${error.message}`);
  process.exit(1);
}
