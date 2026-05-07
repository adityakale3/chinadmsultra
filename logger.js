// Tiny structured logger. Writes one line per event so it's easy to grep / share.
// LOG_LEVEL=debug shows raw hex of every frame in/out. Default is info.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const level = LEVELS[process.env.LOG_LEVEL || 'debug'] ?? 3;

function ts() { return new Date().toISOString(); }

function fmt(tag, msg, extra) {
  const base = `[${ts()}] [${tag}] ${msg}`;
  if (extra === undefined) return base;
  if (typeof extra === 'string') return `${base} ${extra}`;
  try { return `${base} ${JSON.stringify(extra)}`; } catch { return base; }
}

function make(tag) {
  return {
    error: (m, e) => level >= 0 && console.log(fmt(tag, 'ERROR ' + m, e)),
    warn:  (m, e) => level >= 1 && console.log(fmt(tag, 'WARN  ' + m, e)),
    info:  (m, e) => level >= 2 && console.log(fmt(tag, m, e)),
    debug: (m, e) => level >= 3 && console.log(fmt(tag, m, e)),
    hex:   (label, buf) => level >= 3 && console.log(fmt(tag, label, buf.toString('hex'))),
  };
}

module.exports = { make };
