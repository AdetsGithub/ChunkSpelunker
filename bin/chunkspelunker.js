#!/usr/bin/env node
import { runCli } from '../src/cli.js';

runCli(process.argv).catch((err) => {
  console.error(`[!] ${err?.stack || err}`);
  process.exit(err?.exitCode ?? 3);
});
