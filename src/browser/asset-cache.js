import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export class AssetCache {
  /**
   * @param {string} tmpdir
   * @param {{ debug?: Function }} log
   */
  constructor(tmpdir, log = {}) {
    this.tmpdir = tmpdir;
    this.jsDir = path.join(tmpdir, 'js');
    this.srcDir = path.join(tmpdir, 'src');
    this.log = log;
    /** @type {Map<string, import('./models.js').JsAssetMeta>} */
    this.assets = new Map();
    /** @type {Map<string, Promise<string>>} */
    this.inFlight = new Map();
  }

  async init() {
    await fs.mkdir(this.jsDir, { recursive: true });
    await fs.mkdir(this.srcDir, { recursive: true });
  }

  hashUrl(url) {
    return crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
  }

  /**
   * @param {string} url
   * @param {Buffer|string} body
   * @param {{ contentType?: string, pageUrl?: string }} meta
   */
  async writeJs(url, body, meta = {}) {
    const key = this.hashUrl(url);
    const existing = this.assets.get(url);
    if (existing) {
      if (meta.pageUrl) existing.pageUrls.add(meta.pageUrl);
      return existing.diskPath;
    }

    if (this.inFlight.has(key)) {
      const diskPath = await this.inFlight.get(key);
      const asset = this.assets.get(url);
      if (asset && meta.pageUrl) asset.pageUrls.add(meta.pageUrl);
      return diskPath;
    }

    const diskPath = path.join(this.jsDir, `${key}.js`);
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const writePromise = fs.writeFile(diskPath, buf).then(() => diskPath);
    this.inFlight.set(key, writePromise);

    try {
      await writePromise;
      const pageUrls = new Set();
      if (meta.pageUrl) pageUrls.add(meta.pageUrl);
      this.assets.set(url, {
        url,
        diskPath,
        contentType: meta.contentType,
        byteLength: buf.length,
        pageUrls,
      });
      return diskPath;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * @param {string} url
   * @param {string} pageUrl
   */
  notePageUrl(url, pageUrl) {
    const asset = this.assets.get(url);
    if (asset) asset.pageUrls.add(pageUrl);
  }

  pageUrlsFor(url) {
    return this.assets.get(url)?.pageUrls ?? new Set();
  }

  async cleanup() {
    await fs.rm(this.tmpdir, { recursive: true, force: true });
  }
}
