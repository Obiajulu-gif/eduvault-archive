#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = path.join(root, 'dist', 'release');
const filesDir = path.join(outDir, 'files');
mkdirSync(filesDir, { recursive: true });

function sha256(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

function git(cmd) {
  try { return execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}

const include = [
  'package.json',
  'package-lock.json',
  'next.config.mjs',
  'README.md',
  'docs',
  'src',
  'public',
  'soroban',
  'scripts',
].filter((p) => existsSync(path.join(root, p)));

function addPath(rel) {
  const abs = path.join(root, rel);
  const st = statSync(abs);
  if (st.isDirectory()) {
    for (const child of readdirSync(abs)) addPath(path.join(rel, child));
    return;
  }
  const dest = path.join(filesDir, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(abs, dest);
}

for (const rel of include) addPath(rel);

const artifactFiles = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs);
    else artifactFiles.push(abs);
  }
}
walk(filesDir);
artifactFiles.sort();

const checksums = artifactFiles.map((abs) => {
  const rel = path.relative(outDir, abs).replaceAll(path.sep, '/');
  return `${sha256(abs)}  ${rel}`;
}).join('\n') + '\n';
writeFileSync(path.join(outDir, 'SHA256SUMS'), checksums);

const manifest = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  git: {
    commit: git('git rev-parse HEAD'),
    ref: git('git rev-parse --abbrev-ref HEAD'),
    describe: git('git describe --always --dirty --tags'),
  },
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  files: artifactFiles.map((abs) => ({
    path: path.relative(outDir, abs).replaceAll(path.sep, '/'),
    size: statSync(abs).size,
    sha256: sha256(abs),
  })),
};
writeFileSync(path.join(outDir, 'release-manifest.json'), JSON.stringify(manifest, null, 2));

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    timestamp: manifest.createdAt,
    component: {
      type: 'application',
      name: 'eduvault-archive',
      version: manifest.git.describe || manifest.git.commit || 'unknown',
    },
  },
  components: [],
};
try {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  sbom.components = Object.entries(deps).sort(([a],[b]) => a.localeCompare(b)).map(([name, version]) => ({
    type: 'library',
    name,
    version,
    purl: `pkg:npm/${encodeURIComponent(name)}@${String(version).replace(/^[^\d]*/, '')}`,
  }));
} catch {}
writeFileSync(path.join(outDir, 'sbom.cdx.json'), JSON.stringify(sbom, null, 2));

const provenance = {
  schemaVersion: 1,
  type: 'eduvault.release.provenance',
  generatedAt: manifest.createdAt,
  source: {
    repository: git('git config --get remote.origin.url'),
    commit: manifest.git.commit,
    ref: manifest.git.ref,
  },
  build: {
    command: 'node scripts/create-release-artifacts.mjs',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  artifacts: {
    manifest: 'release-manifest.json',
    checksums: 'SHA256SUMS',
    sbom: 'sbom.cdx.json',
  },
};
writeFileSync(path.join(outDir, 'provenance.json'), JSON.stringify(provenance, null, 2));

console.log(JSON.stringify({ outDir: path.relative(root, outDir), files: manifest.files.length }, null, 2));
