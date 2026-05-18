// Append-only persistence for alert records (so /events + dashboard keep
// lat/lon/deviceTime/eventName across PM2 restarts).
//
// Format: one JSON object per line in data/alerts.jsonl.
//
// We deliberately only persist attachment_request alerts (the ones that carry
// alarmNumber + lat/lon). Heartbeats/locations are not persisted.

const fs = require('fs');
const path = require('path');

const DATA_DIR    = path.join(__dirname, 'data');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.jsonl');
const MAX_LINES   = Number(process.env.PERSIST_MAX_LINES || 20_000);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const stream = fs.createWriteStream(ALERTS_FILE, { flags: 'a' });
let appended = 0;

function appendAlert(entry) {
  try {
    stream.write(JSON.stringify(entry) + '\n');
    appended++;
  } catch (e) { /* swallow — should never lose runtime */ }
}

function loadAlerts() {
  if (!fs.existsSync(ALERTS_FILE)) return [];
  try {
    return fs.readFileSync(ALERTS_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .slice(-MAX_LINES);  // keep only last N to bound memory
  } catch { return []; }
}

// Truncate the file to the last MAX_LINES — call sparingly.
function compact() {
  const lines = loadAlerts();
  fs.writeFileSync(ALERTS_FILE, lines.map(o => JSON.stringify(o)).join('\n') + '\n');
}

function stats() { return { file: ALERTS_FILE, appendedThisSession: appended, maxLines: MAX_LINES }; }

module.exports = { appendAlert, loadAlerts, compact, stats };
