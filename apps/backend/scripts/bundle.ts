import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
/**
 * Builds the gateway into one ES module that runs with plain `node` (20 or later) from any directory: every
 * dependency, the default screen and the screen kit are inside it. `npm --workspace @marionette/backend run bundle`
 * writes `apps/backend/dist/marionette-gateway.mjs`.
 */
export async function bundle(options: { outfile?: string; kitDir?: string } = {}): Promise<string> {
  const outfile = options.outfile ?? here('../dist/marionette-gateway.mjs'); const kitDir = options.kitDir ?? here('../../../packages/kit');
  const kitFile = (name: string) => { try { return fs.readFileSync(path.join(kitDir, name), 'utf8'); } catch { console.warn(`bundle: ${path.join(kitDir, name)} not found; the bundled kit is empty`); return ''; } };
  // Read by src/screens.ts in place of the files beside the sources.
  const assets = { 'sample-controls.html': fs.readFileSync(here('../src/sample-controls.html'), 'utf8'), 'marionette-kit.js': kitFile('marionette-kit.js'), 'marionette-kit.css': kitFile('marionette-kit.css') };
  await build({ entryPoints: [here('../src/main.ts')], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'warning', legalComments: 'none',
    // express and its friends are CommonJS and require Node's built-ins, which an ES module has to provide.
    banner: { js: `import { createRequire as __marionetteRequire } from 'node:module';\nconst require = __marionetteRequire(import.meta.url);\nglobalThis.__marionetteAssets = ${JSON.stringify(assets)};` },
    // ws loads these native speed-ups only if they are installed.
    external: ['bufferutil', 'utf-8-validate'] });
  return outfile;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(`Wrote ${path.relative(process.cwd(), await bundle())}`);
