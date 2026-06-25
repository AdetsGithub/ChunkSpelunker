import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ast-worker.js');

export class AstPool {
  /**
   * @param {object} opts
   * @param {number} opts.size
   * @param {number} opts.timeoutMs
   * @param {number} opts.maxJsBytes
   * @param {{ info?: Function, debug?: Function, warn?: Function }} opts.log
   */
  constructor({ size, timeoutMs, maxJsBytes, log }) {
    this.size = Math.max(1, size);
    this.timeoutMs = timeoutMs;
    this.maxJsBytes = maxJsBytes;
    this.log = log;
    this.closing = false;
    /** @type {Worker[]} */
    this.workers = [];
    /** @type {Worker[]} */
    this.idle = [];
    /** @type {Array<{job: object, resolve: Function, reject: Function}>} */
    this.queue = [];
    this.analyzed = 0;
    this.total = 0;
  }

  start() {
    for (let i = 0; i < this.size; i++) this.#spawn();
  }

  #spawn() {
    if (this.closing) return;
    const worker = new Worker(workerPath);
    worker.on('error', (err) => {
      this.log.warn?.(`AST worker error: ${err.message}`);
    });
    worker.on('exit', (code) => {
      this.workers = this.workers.filter((w) => w !== worker);
      this.idle = this.idle.filter((w) => w !== worker);
      if (!this.closing && code !== 0) {
        this.log.debug?.(`AST worker exited code ${code}; respawning`);
        this.#spawn();
        this.#pump();
      }
    });
    this.workers.push(worker);
    this.idle.push(worker);
  }

  /**
   * @param {{ url: string, filePath: string, mode?: string }} job
   */
  run(job) {
    this.total++;
    return new Promise((resolve, reject) => {
      this.queue.push({
        job: {
          jobId: randomUUID(),
          url: job.url,
          filePath: job.filePath,
          mode: job.mode || 'ast',
          maxJsBytes: this.maxJsBytes,
        },
        resolve,
        reject,
      });
      this.#pump();
    });
  }

  #pump() {
    while (this.idle.length && this.queue.length) {
      const worker = this.idle.pop();
      const item = this.queue.shift();
      this.#dispatch(worker, item);
    }
  }

  #dispatch(worker, item) {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.log.warn?.(`AST timeout for ${item.job.url}`);
      worker.terminate().catch(() => {});
      this.workers = this.workers.filter((w) => w !== worker);
      this.#spawn();
      this.analyzed++;
      item.resolve({
        jobId: item.job.jobId,
        ok: true,
        findings: [],
        engine: 'none',
        degradedReason: 'timeout',
      });
      this.#pump();
    }, this.timeoutMs);

    const onMessage = (msg) => {
      if (msg.jobId !== item.job.jobId || settled) return;
      settled = true;
      clearTimeout(timer);
      worker.off('message', onMessage);
      this.idle.push(worker);
      this.analyzed++;
      if (this.analyzed % 10 === 0 || this.analyzed === this.total) {
        this.log.info?.(`analyzed ${this.analyzed}/${this.total}`);
      }
      item.resolve(msg);
      this.#pump();
    };

    worker.on('message', onMessage);
    worker.postMessage(item.job);
  }

  async close() {
    this.closing = true;
    await Promise.all(this.workers.map((w) => w.terminate().catch(() => {})));
    this.workers = [];
    this.idle = [];
  }
}
