import { parentPort } from 'node:worker_threads';
import fs from 'node:fs/promises';
import { extractFromCode } from './ast-extractor.js';
import { regexFallback } from './regex-fallback.js';

parentPort.on('message', async (job) => {
  const { jobId, url, filePath, mode, maxJsBytes } = job;
  try {
    const code = await fs.readFile(filePath, 'utf8');
    if (mode === 'regex-only' || code.length > maxJsBytes) {
      const findings = regexFallback(code, url);
      parentPort.postMessage({
        jobId,
        ok: true,
        findings,
        engine: 'regex',
        degradedReason: code.length > maxJsBytes ? 'max-bytes' : undefined,
      });
      return;
    }

    const result = extractFromCode(code, url);
    parentPort.postMessage({
      jobId,
      ok: true,
      findings: result.findings,
      engine: result.engine,
      degradedReason: result.degradedReason,
    });
  } catch (err) {
    let findings = [];
    try {
      const code = await fs.readFile(filePath, 'utf8');
      findings = regexFallback(code, url);
    } catch {
      /* ignore */
    }
    parentPort.postMessage({
      jobId,
      ok: false,
      error: err?.message || String(err),
      findings,
      degradedReason: err instanceof RangeError ? 'range-error' : 'read-error',
    });
  }
});
