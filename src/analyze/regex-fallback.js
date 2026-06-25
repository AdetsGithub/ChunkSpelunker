import { isPathLike, toPostmanTemplate } from './url-utils.js';

const CHUNK_SIZE = 96_000;
const MAX_CHUNKS = 2000;
const MAX_MATCHES_PER_CHUNK = 50;

/** Linear-ish patterns — avoid nested quantifiers */
const PATH_RE = /["'`](\/[A-Za-z0-9_\-./{}]{3,})["'`]/g;
const URL_RE = /["'`](https?:\/\/[A-Za-z0-9.\-_/:?&=%#]+)["'`]/g;
const REL_RE = /["'`](\.\.?\/[A-Za-z0-9_\-./{}]+)["'`]/g;

/**
 * ReDoS-safe regex endpoint extraction.
 * @param {string} code
 * @param {string} sourceUrl
 */
export function regexFallback(code, sourceUrl) {
  const findings = [];
  const seen = new Set();

  const chunks = chunkCode(code);
  let chunkCount = 0;
  for (const chunk of chunks) {
    if (chunkCount++ >= MAX_CHUNKS) break;
    extractFromChunk(chunk, sourceUrl, findings, seen);
  }

  return findings;
}

function chunkCode(code) {
  if (code.length <= 256_000) {
    // Still split single-line monsters
    if (!code.includes('\n') && code.length > CHUNK_SIZE) {
      return splitHard(code);
    }
    return code.includes('\n') ? code.split(/\n/) : [code];
  }
  return splitHard(code);
}

function splitHard(code) {
  const parts = [];
  // Split on common minified separators without regex backtracking
  let start = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '\n' || c === ';' || c === ',' || (i - start >= CHUNK_SIZE)) {
      if (i > start) parts.push(code.slice(start, i + 1));
      start = i + 1;
      if (parts.length >= MAX_CHUNKS) break;
    }
  }
  if (start < code.length && parts.length < MAX_CHUNKS) {
    parts.push(code.slice(start));
  }
  return parts;
}

function extractFromChunk(chunk, sourceUrl, findings, seen) {
  let matches = 0;
  for (const re of [PATH_RE, URL_RE, REL_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(chunk)) !== null) {
      if (matches++ >= MAX_MATCHES_PER_CHUNK) return;
      const raw = m[1];
      if (!isPathLike(raw)) continue;
      const key = raw;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        method: 'GET',
        rawPath: toPostmanTemplate(raw),
        url: raw,
        pathTemplate: toPostmanTemplate(raw),
        queryParams: [],
        bodyParams: [],
        headers: {},
        source: 'regex',
        confidence: 'low',
        evidence: { jsUrls: [sourceUrl], rawPath: raw },
      });
    }
  }
}
