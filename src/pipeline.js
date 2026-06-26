import fs from 'node:fs/promises';
import { stringify as stringifyYaml } from 'yaml';
import { crawl } from './browser/crawler.js';
import { discoverSourceMaps } from './sourcemap/discover.js';
import { AstPool } from './analyze/ast-pool.js';
import { mergeFindings } from './merge/dedupe.js';
import { toPostman } from './export/postman.js';
import { toOpenApi } from './export/openapi.js';
import { toRaw } from './export/raw.js';

/**
 * @param {object} options
 * @param {ReturnType<import('./log.js').createLogger>} log
 */
export async function runPipeline(options, log) {
  await fs.mkdir(options.tmpdir, { recursive: true });
  if (options.saveSources) await fs.mkdir(options.saveSources, { recursive: true });

  let session;
  try {
    session = await crawl(options, log);
    const { cache, network, fetcher, browser } = session;

    log.info(`Captured ${cache.assets.size} JS assets, ${network.calls.length} network calls`);

    const { reconstructed, mapCount } = await discoverSourceMaps({
      cache,
      fetcher,
      options,
      log,
    });
    log.info(`Reconstructed ${reconstructed.size} sources from ${mapCount} maps`);

    const pool = new AstPool({
      size: options.astWorkers,
      timeoutMs: options.astTimeout,
      maxJsBytes: options.maxJsBytes,
      log,
    });
    pool.start();

    /** @type {any[]} */
    const staticFindings = [];
    try {
      const jobs = [];
      let n = 0;
      for (const asset of cache.assets.values()) {
        if (n++ >= options.maxJs) break;
        jobs.push(
          pool.run({ url: asset.url, filePath: asset.diskPath }).then((r) => {
            staticFindings.push(...(r.findings || []));
          }),
        );
      }
      for (const [logical, meta] of reconstructed) {
        if (!options.includeVendor && /node_modules/.test(logical)) continue;
        jobs.push(
          pool
            .run({ url: meta.fromJsUrl || logical, filePath: meta.diskPath })
            .then((r) => {
              staticFindings.push(...(r.findings || []));
            }),
        );
      }
      await Promise.all(jobs);
    } finally {
      await pool.close();
    }

    log.info(`Static findings: ${staticFindings.length}`);

    const findings = mergeFindings({
      networkCalls: network.calls,
      staticFindings,
      websockets: network.websockets,
      sseUrls: network.sseUrls,
      baseUrl: options.baseUrl,
      cache,
      log,
    });

    log.info(`Merged endpoints: ${findings.length}`);

    const stats = {
      jsAssets: cache.assets.size,
      sourceMaps: mapCount,
      reconstructedFiles: reconstructed.size,
      networkEndpoints: network.calls.length,
      staticEndpoints: staticFindings.length,
      mergedEndpoints: findings.length,
    };

    let output;
    if (options.format === 'postman') {
      output = toPostman(findings, { baseUrl: options.baseUrl });
    } else if (options.format === 'openapi') {
      output = toOpenApi(findings, { baseUrl: options.baseUrl });
    } else {
      output = toRaw({
        baseUrl: options.baseUrl,
        stats,
        cache,
        mapCount,
        reconstructed,
        findings,
        network,
      });
    }

    const text =
      options.format === 'openapi' &&
      /\.ya?ml$/i.test(options.output)
        ? stringifyYaml(output)
        : JSON.stringify(output, null, 2);

    await fs.writeFile(options.output, text, 'utf8');
    log.info(`Wrote ${options.format} collection to ${options.output}`);

    await browser.close();
    session = null;

    if (!options.keepTmpdir) {
      await cache.cleanup();
      log.debug(`cleaned tmpdir ${options.tmpdir}`);
    } else {
      log.info(`Keeping tmpdir ${options.tmpdir}`);
    }
  } catch (err) {
    if (session?.browser) await session.browser.close().catch(() => {});
    if (session?.cache && !options.keepTmpdir) {
      await session.cache.cleanup().catch(() => {});
    }
    throw err;
  }
}
