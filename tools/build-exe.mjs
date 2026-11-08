import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workDir = join(root, '.cache', 'exe');
const outputDir = join(root, 'dist');
const webDist = join(root, 'apps', 'web', 'dist');
const bundlePath = join(workDir, 'tsinspect.cjs');
const blobPath = join(workDir, 'tsinspect.blob');
const configPath = join(workDir, 'sea-config.json');
const exePath = join(outputDir, 'tsinspect.exe');
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    stdio: 'inherit',
    shell: options.shell ?? false,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

async function listAssets(directory) {
  const assets = {};
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(assets, await listAssets(absolute));
    } else if (entry.isFile()) {
      const key = relative(webDist, absolute).split(sep).join('/');
      assets[`web/${key}`] = absolute;
    }
  }
  return assets;
}

async function main() {
  process.stdout.write('Building web UI...\n');
  if (process.platform === 'win32') {
    run(process.env.ComSpec ?? 'cmd.exe', [
      '/d',
      '/s',
      '/c',
      'corepack',
      'pnpm',
      '--filter',
      '@tsinspect/web',
      'build',
    ]);
  } else {
    run('corepack', ['pnpm', '--filter', '@tsinspect/web', 'build']);
  }

  await stat(join(webDist, 'index.html'));

  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  process.stdout.write('Bundling CLI and server (CommonJS)...\n');
  await build({
    entryPoints: [join(root, 'apps', 'cli', 'src', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: bundlePath,
    sourcemap: false,
    legalComments: 'none',
    // Only the dev fallback loads esbuild at runtime; the packaged executable
    // embeds the worker bundle below instead.
    external: ['esbuild'],
  });

  process.stdout.write('Bundling probe worker...\n');
  await build({
    entryPoints: [join(root, 'apps', 'server', 'src', 'probe-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: join(workDir, 'probe-worker.cjs'),
    sourcemap: false,
    legalComments: 'none',
  });

  const assets = await listAssets(webDist);
  assets['worker/probe-worker.cjs'] = join(workDir, 'probe-worker.cjs');
  const config = {
    main: bundlePath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    assets,
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  process.stdout.write(`Preparing SEA blob with ${Object.keys(assets).length} web assets...\n`);
  run(process.execPath, ['--experimental-sea-config', configPath]);

  await copyFile(process.execPath, exePath);

  process.stdout.write('Injecting SEA blob...\n');
  const postjectCli = require.resolve('postject/dist/cli.js');
  run(process.execPath, [
    postjectCli,
    exePath,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    SENTINEL_FUSE,
  ]);

  const info = await stat(exePath);
  process.stdout.write(`\nBuilt ${exePath} (${(info.size / 1024 / 1024).toFixed(1)} MiB)\n`);
  process.stdout.write(`Run "${exePath}" to open the web UI, or "${exePath} probe <file>" for the CLI.\n`);
}

await main();
