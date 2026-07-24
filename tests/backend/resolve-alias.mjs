import { resolve as pathResolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const srcPath = pathResolve(fileURLToPath(new URL('.', import.meta.url)), '../../src');

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const actual = specifier.replace('@/', `${srcPath}/`) + '.js';
    return nextResolve(actual);
  }
  return nextResolve(specifier);
}
