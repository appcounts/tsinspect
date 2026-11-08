import { parentPort, workerData } from 'node:worker_threads';
import { probeBuffer, type ProbeOptions, type ProbeProgress } from '@tsinspect/core';

interface ProbeWorkerData {
  buffer: ArrayBuffer;
  byteOffset: number;
  byteLength: number;
  options: ProbeOptions;
}

const port = parentPort;
if (!port) throw new Error('probe worker requires a parent port');
const { buffer, byteOffset, byteLength, options } = workerData as ProbeWorkerData;

try {
  const result = probeBuffer(new Uint8Array(buffer, byteOffset, byteLength), {
    ...options,
    onProgress: (progress: ProbeProgress) => port.postMessage({ type: 'progress', progress }),
  });
  // Hand the buffer back so the server can keep serving the session without
  // copying it a second time.
  port.postMessage({ type: 'result', result, buffer, byteOffset, byteLength }, [buffer]);
} catch (error) {
  port.postMessage({
    type: 'error',
    error: error instanceof Error ? error.message : String(error),
  });
}
