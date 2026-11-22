#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dir = path.resolve(root, process.argv[2] || 'dist/release');
function fail(msg) { console.error(msg); process.exit(1); }
function sha256(filePath) { const h=createHash('sha256'); h.update(readFileSync(filePath)); return h.digest('hex'); }

for (const name of ['SHA256SUMS','release-manifest.json','sbom.cdx.json','provenance.json']) {
  if (!existsSync(path.join(dir, name))) fail(`Missing required artifact: ${name}`);
}

const checksums = readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').trim().split(/\r?\n/).filter(Boolean);
for (const line of checksums) {
  const m = line.match(/^([a-f0-9]{64})\s\s(.+)$/);
  if (!m) fail(`Invalid checksum line: ${line}`);
  const [, expected, rel] = m;
  const abs = path.join(dir, rel);
  if (!existsSync(abs)) fail(`Missing file listed in checksums: ${rel}`);
  const actual = sha256(abs);
  if (actual !== expected) fail(`Checksum mismatch for ${rel}: expected ${expected}, got ${actual}`);
}

const manifest = JSON.parse(readFileSync(path.join(dir, 'release-manifest.json'), 'utf8'));
for (const f of manifest.files || []) {
  const abs = path.join(dir, f.path);
  if (!existsSync(abs)) fail(`Manifest file missing: ${f.path}`);
  const actual = sha256(abs);
  if (actual !== f.sha256) fail(`Manifest hash mismatch: ${f.path}`);
}

const sbom = JSON.parse(readFileSync(path.join(dir, 'sbom.cdx.json'), 'utf8'));
if (sbom.bomFormat !== 'CycloneDX') fail('SBOM bomFormat must be CycloneDX');
if (!Array.isArray(sbom.components)) fail('SBOM components must be array');

const provenance = JSON.parse(readFileSync(path.join(dir, 'provenance.json'), 'utf8'));
if (!provenance.source?.commit) fail('Provenance missing source.commit');
if (provenance.artifacts?.checksums !== 'SHA256SUMS') fail('Provenance checksums reference invalid');

console.log(JSON.stringify({ ok: true, dir, files: manifest.files?.length || 0 }));
