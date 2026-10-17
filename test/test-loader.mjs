import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(new URL('./test-loader-hooks.mjs', import.meta.url).href, import.meta.url);
