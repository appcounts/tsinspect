import { startServer } from './app.js';

startServer()
  .then(({ url }) => {
    process.stdout.write(`tsinspect web UI: ${url}\n`);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`tsinspect: ${message}\n`);
    process.exitCode = 1;
  });
