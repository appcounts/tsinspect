import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [join(root, 'apps', 'cli', 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: join(root, 'apps', 'cli', 'dist', 'index.js'),
  sourcemap: false,
  legalComments: 'none',
  banner: {
    // Fastify's CommonJS dependencies call require() for Node built-ins. Keep
    // the ESM bundle able to resolve them while the CLI stays an ES module.
    js: 'import { createRequire } from "node:module";const require = createRequire(import.meta.url);',
  },
  // esbuild is only used by the dev fallback that bundles the probe worker on
  // demand; never ship it inside the CLI bundle.
  external: ['esbuild'],
});

// The server runs probes in this worker so it can stream progress and abort a
// running analysis. The CLI keeps the file next to its own bundle.
await build({
  entryPoints: [join(root, 'apps', 'server', 'src', 'probe-worker.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: join(root, 'apps', 'cli', 'dist', 'probe-worker.cjs'),
  sourcemap: false,
  legalComments: 'none',
});
