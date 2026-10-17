import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(testDir, '..');

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const subpath = specifier.slice(2);
    let resolvedPath = path.resolve(rootDir, 'src', subpath);
    if (!fs.existsSync(resolvedPath)) {
      if (fs.existsSync(resolvedPath + '.js')) resolvedPath += '.js';
      else if (fs.existsSync(resolvedPath + '.mjs')) resolvedPath += '.mjs';
      else if (fs.existsSync(resolvedPath + '.json')) resolvedPath += '.json';
      else if (fs.existsSync(path.join(resolvedPath, 'index.js'))) resolvedPath = path.join(resolvedPath, 'index.js');
    }
    return nextResolve(pathToFileURL(resolvedPath).href, context);
  }
  return nextResolve(specifier, context);
}
