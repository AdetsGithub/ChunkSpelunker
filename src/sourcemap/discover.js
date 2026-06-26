import path from 'node:path';
import fs from 'node:fs/promises';
import { SourceMapConsumer } from 'source-map';

const SOURCEMAP_RE = /(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL\s*=\s*(\S+)/;

/**
 * @param {string} jsCode
 * @param {string} jsUrl
 */
export function findSourceMappingURL(jsCode, jsUrl) {
  const lines = jsCode.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const m = lines[i].match(SOURCEMAP_RE);
    if (!m) continue;
    const ref = m[1].replace(/\*\/\s*$/, '').trim();
    if (ref.startsWith('data:')) return { type: 'data', value: ref };
    try {
      return { type: 'url', value: new URL(ref, jsUrl).href };
    } catch {
      return { type: 'url', value: ref };
    }
  }
  return null;
}

/**
 * @param {string} dataUrl
 */
export function decodeDataMap(dataUrl) {
  const m = dataUrl.match(/^data:([^,]+),(.*)$/s);
  if (!m) throw new Error('Invalid data URL sourcemap');
  const meta = m[1];
  const data = m[2];
  if (/;base64/i.test(meta)) {
    return JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  }
  return JSON.parse(decodeURIComponent(data));
}

/**
 * Reconstruct sources from a map object to disk.
 * @returns {Promise<Array<{ logicalPath: string, diskPath: string }>>}
 */
export async function reconstructToDisk(mapJson, outDir, { fromMapUrl, fromJsUrl }) {
  await fs.mkdir(outDir, { recursive: true });
  const written = [];

  if (mapJson.version !== 3) {
    throw new Error(`Unsupported sourcemap version ${mapJson.version}`);
  }

  const sources = mapJson.sources || [];
  const contents = mapJson.sourcesContent || [];

  for (let i = 0; i < sources.length; i++) {
    let content = contents[i];
    if (content == null || content === 'null') continue;

    const logical = normalizeWebpackPath(sources[i]);
    if (!logical || logical.includes('node_modules') && !logical) continue;

    const safe = sanitizePath(logical);
    const diskPath = path.join(outDir, safe);
    const resolved = path.resolve(diskPath);
    if (!resolved.startsWith(path.resolve(outDir))) continue;

    await fs.mkdir(path.dirname(diskPath), { recursive: true });
    await fs.writeFile(diskPath, content, 'utf8');
    written.push({ logicalPath: logical, diskPath, fromMapUrl, fromJsUrl });
  }

  // Ensure consumer can parse (validates map)
  await SourceMapConsumer.with(mapJson, null, async () => {});

  return written;
}

export function normalizeWebpackPath(p) {
  return String(p)
    .replace(/^webpack:\/\//, '')
    .replace(/^\//, '')
    .replace(/^\.\//, '')
    .replace(/^~\//, 'node_modules/')
    .replace(/^\(webpack\)\//, '')
    .replace(/^\/+/, '');
}

function sanitizePath(p) {
  return p
    .split(/[/\\]/)
    .filter((s) => s && s !== '.' && s !== '..')
    .join(path.sep);
}

/**
 * Discover and reconstruct maps for all cached JS assets.
 */
export async function discoverSourceMaps({ cache, fetcher, options, log }) {
  /** @type {Map<string, { diskPath: string, fromMapUrl: string, fromJsUrl: string }>} */
  const reconstructed = new Map();
  let mapCount = 0;
  const assets = [...cache.assets.values()].slice(0, options.maxJs);

  for (const asset of assets) {
    let code;
    try {
      code = await fs.readFile(asset.diskPath, 'utf8');
    } catch {
      continue;
    }

    const ref = findSourceMappingURL(code, asset.url);
    let mapJson = null;
    let mapUrl = null;

    if (ref?.type === 'data') {
      try {
        mapJson = decodeDataMap(ref.value);
        mapUrl = `data:${asset.url}`;
      } catch (err) {
        log.debug(`inline map decode failed for ${asset.url}: ${err.message}`);
      }
    } else {
      const candidates = [];
      if (ref?.type === 'url') candidates.push(ref.value);
      candidates.push(`${asset.url}.map`);

      for (const candidate of candidates) {
        const res = await fetcher.fetch(candidate);
        if (res.ok && res.body) {
          try {
            mapJson = JSON.parse(res.body.toString('utf8'));
            mapUrl = candidate;
            break;
          } catch {
            /* try next */
          }
        }
      }
    }

    if (!mapJson) continue;
    mapCount++;
    log.info(`Source map found for ${asset.url}`);
    const outDir = path.join(cache.srcDir, cache.hashUrl(asset.url));
    try {
      const files = await reconstructToDisk(mapJson, outDir, {
        fromMapUrl: mapUrl,
        fromJsUrl: asset.url,
      });
      for (const f of files) {
        if (!options.includeVendor && /node_modules/.test(f.logicalPath)) continue;
        reconstructed.set(f.logicalPath, {
          diskPath: f.diskPath,
          fromMapUrl: mapUrl,
          fromJsUrl: asset.url,
        });
      }
      if (options.saveSources) {
        // copy tree already under outDir; also mirror to saveSources
        await fs.cp(outDir, path.join(options.saveSources, cache.hashUrl(asset.url)), {
          recursive: true,
          force: true,
        });
      }
    } catch (err) {
      log.debug(`reconstruct failed: ${err.message}`);
    }
  }

  return { reconstructed, mapCount };
}
