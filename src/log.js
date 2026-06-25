/** @typedef {'info' | 'debug' | 'warn' | 'error'} LogLevel */

export function createLogger({ verbose = false, quiet = false } = {}) {
  const write = (prefix, msg, level = 'info') => {
    if (quiet && level !== 'error') return;
    if (level === 'debug' && !verbose) return;
    const stream = level === 'error' ? process.stderr : process.stderr;
    stream.write(`${prefix} ${msg}\n`);
  };

  return {
    info: (msg) => write('[+]', msg, 'info'),
    debug: (msg) => write('[.]', msg, 'debug'),
    warn: (msg) => write('[!]', msg, 'warn'),
    error: (msg) => write('[!]', msg, 'error'),
  };
}
