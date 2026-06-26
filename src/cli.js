import { Command } from 'commander';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CLICK_SELECTOR,
  DEFAULT_EXCLUDE_SELECTOR,
  DEFAULT_HYDRATE_FORMAT,
} from './models.js';
import { createLogger } from './log.js';
import { runPipeline } from './pipeline.js';

function parseHeader(value, previous = []) {
  const idx = value.indexOf(':');
  if (idx === -1) {
    throw new Error(`Invalid header (expected "Name: Value"): ${value}`);
  }
  const name = value.slice(0, idx).trim();
  const val = value.slice(idx + 1).trim();
  if (!name) throw new Error(`Invalid header name: ${value}`);
  previous.push({ name, value: val, raw: value });
  return previous;
}

function defaultAstWorkers() {
  const n = Math.max(1, (os.cpus()?.length || 2) - 1);
  return Math.min(4, n);
}

/**
 * @param {string[]} argv
 */
export async function runCli(argv) {
  const program = new Command();

  program
    .name('chunkspelunker')
    .description(
      'Crawl SPAs, recover source maps, extract API endpoints, export Postman/OpenAPI collections',
    )
    .requiredOption('-u, --url <url>', 'Target application URL')
    .option('-c, --cookie <string>', 'Cookie string for authenticated crawling')
    .option(
      '-H, --header <string>',
      'Custom header "Name: Value" (repeatable; same-origin for Node re-fetches)',
      parseHeader,
      [],
    )
    .option('-d, --depth <int>', 'Crawl depth for internal routes', (v) => parseInt(v, 10), 1)
    .option('-o, --output <file>', 'Output file path', 'chunkspelunker-output.json')
    .option('-f, --format <type>', 'Export format: postman | openapi | raw', 'postman')
    .option('--state <file>', 'Playwright storageState JSON (cookies + local/session storage)')
    .option(
      '--map-header <string>',
      'Header used only for source map fetches (repeatable)',
      parseHeader,
      [],
    )
    .option(
      '--map-origin <origin>',
      'Extra origin allowed for map fetches / map-headers (repeatable)',
      (v, prev = []) => [...prev, v],
      [],
    )
    .option('--timeout <ms>', 'Navigation timeout in ms', (v) => parseInt(v, 10), 30000)
    .option(
      '--wait-until <event>',
      'Playwright waitUntil: load | domcontentloaded | networkidle | commit',
      'domcontentloaded',
    )
    .option('--headless', 'Run headless (default)', true)
    .option('--no-headless', 'Show browser window')
    .option('--user-agent <ua>', 'Override User-Agent')
    .option('--proxy <url>', 'HTTP(S) proxy URL')
    .option('--insecure', 'Ignore TLS certificate errors', false)
    .option('--same-origin-only', 'Only crawl same-origin routes', true)
    .option('--no-same-origin-only', 'Allow cross-origin crawl links')
    .option('--allow-external-maps', 'Permit fetching source maps from other origins', false)
    .option('--include-vendor', 'Analyze reconstructed node_modules / vendor sources', false)
    .option('--max-js <n>', 'Max JS assets to analyze', (v) => parseInt(v, 10), 500)
    .option(
      '--max-js-bytes <n>',
      'Skip Babel above this size (regex-only)',
      (v) => parseInt(v, 10),
      5_242_880,
    )
    .option(
      '--max-body-bytes <n>',
      'Truncate captured network bodies',
      (v) => parseInt(v, 10),
      262_144,
    )
    .option('--tmpdir <dir>', 'Scratch directory for intercepted assets')
    .option('--keep-tmpdir', 'Retain scratch directory after run', false)
    .option('--ast-workers <n>', 'Babel worker pool size', (v) => parseInt(v, 10), defaultAstWorkers())
    .option(
      '--ast-timeout <ms>',
      'Per-file AST worker timeout',
      (v) => parseInt(v, 10),
      30_000,
    )
    .option(
      '--map-concurrency <n>',
      'Max concurrent map fetches',
      (v) => parseInt(v, 10),
      4,
    )
    .option('--click-selector <css>', 'Crawl click targets', DEFAULT_CLICK_SELECTOR)
    .option('--exclude-selector <css>', 'Never click these', DEFAULT_EXCLUDE_SELECTOR)
    .option('--force-clicks', 'Use Playwright force clicks', true)
    .option('--no-force-clicks', 'Disable force clicks')
    .option(
      '--hydrate-format <template>',
      'Hydrated auth header template; must contain {token}',
      DEFAULT_HYDRATE_FORMAT,
    )
    .option('--save-sources <dir>', 'Write reconstructed source tree to disk')
    .option('--verbose', 'Debug logging to stderr', false)
    .option('--quiet', 'Suppress non-error stderr', false)
    .addHelpText(
      'after',
      `
Examples:
  $ chunkspelunker -u https://app.example.com -o collection.json
  $ chunkspelunker -u https://app.example.com/dashboard --state ./auth.json -d 3
  $ chunkspelunker -u https://app.example.com -H "Authorization: Bearer tok" -f openapi -o api.yaml
  $ chunkspelunker -u https://app.example.com --state ./auth.json --hydrate-format "x-api-key: {token}"

Documentation:
  README.md          Install & overview
  docs/CLI.md        Full flag reference
  docs/AUTHENTICATION.md
  docs/EXAMPLES.md   Engagement recipes
  docs/TROUBLESHOOTING.md
  SPEC.md            Architecture (normative)

Authorized testing only. See docs/SECURITY.md.
`,
    );

  program.parse(argv);
  const opts = program.opts();

  if (!['postman', 'openapi', 'raw'].includes(opts.format)) {
    console.error('[!] --format must be postman | openapi | raw');
    process.exit(1);
  }

  if (!opts.hydrateFormat.includes('{token}')) {
    console.error('[!] --hydrate-format must contain {token}');
    process.exit(1);
  }

  let baseUrl;
  try {
    baseUrl = new URL(opts.url);
  } catch {
    console.error(`[!] Invalid --url: ${opts.url}`);
    process.exit(1);
  }

  const log = createLogger({ verbose: opts.verbose, quiet: opts.quiet });
  const tmpdir =
    opts.tmpdir || path.join(os.tmpdir(), `chunkspelunker-${process.pid}`);

  const options = {
    ...opts,
    baseUrl,
    tmpdir,
    headers: opts.header || [],
    mapHeaders: opts.mapHeader || [],
    mapOrigins: opts.mapOrigin || [],
  };

  try {
    await runPipeline(options, log);
    process.exit(0);
  } catch (err) {
    log.error(err?.message || String(err));
    if (opts.verbose && err?.stack) log.debug(err.stack);
    process.exit(err?.exitCode ?? 2);
  }
}
