import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const ignoreDirs = new Set([".git", "node_modules", ".next", "coverage", "dist", "docs", ".github"]);
const ignoreFiles = new Set([".env.example", "env.js", "scan-secrets.mjs"]);
const suspiciousPatterns = [
  /replace-with-a-long-random-string/i,
  /sk-[A-Za-z0-9]{16,}/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/i,
];

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoreDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (entry.isFile()) {
      if (ignoreFiles.has(entry.name)) continue;
      files.push(fullPath);
    }
  }
  return files;
}

const matches = [];
for (const file of walk(root)) {
  if (!/\.(mjs|js|jsx|json|env|cjs)$/.test(file)) continue;
  const content = fs.readFileSync(file, "utf8");
  for (const pattern of suspiciousPatterns) {
    if (pattern.test(content)) {
      matches.push(path.relative(root, file));
      break;
    }
  }
}

if (matches.length > 0) {
  console.error("Potential secret or placeholder values found in:");
  for (const match of matches) console.error(`- ${match}`);
  process.exit(1);
}

console.log("No obvious secrets or placeholder production values found.");
