const net = require('net');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { FtpSrv, FileSystem } = require('ftp-srv');

const { extractFrames, decode } = require('./jt808/codec');
const handlers = require('./jt808/handlers');
const attachmentServer = require('./attachment-server');
const store = require('./store');
const { make } = require('./logger');

const HTTP_PORT       = Number(process.env.HTTP_PORT       || 3000);
const JT808_PORT      = Number(process.env.JT808_PORT      || 7611);
const ATTACHMENT_PORT = Number(process.env.ATTACHMENT_PORT || 7612);
const FTP_PORT        = Number(process.env.FTP_PORT        || 2121);
const PUBLIC_IP       = process.env.PUBLIC_IP || '13.206.186.1';

const log = make('JT808');
const flog = make('FTP');
const hlog = make('HTTP');

const MEDIA_DIR = path.resolve(__dirname, 'media');
const FTP_ROOT  = path.resolve(__dirname, 'ftp');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
if (!fs.existsSync(FTP_ROOT))  fs.mkdirSync(FTP_ROOT,  { recursive: true });

// Devices probe ftp://server/ulv_mdvr2.0/upgrade.ini at boot looking for a firmware
// upgrade. Provide an empty placeholder so they get a 0-byte file instead of ENOENT.
const FW_DIR = path.join(FTP_ROOT, 'ulv_mdvr2.0');
if (!fs.existsSync(FW_DIR)) fs.mkdirSync(FW_DIR, { recursive: true });
const FW_INI = path.join(FW_DIR, 'upgrade.ini');
if (!fs.existsSync(FW_INI)) fs.writeFileSync(FW_INI, '');

// ---------- JT808 TCP server ----------
const jt808 = net.createServer((socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  const connectedAt = Date.now();
  log.info(`+ connect ${peer}`);
  socket.setKeepAlive(true, 30000);
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0);
  let frameCount = 0;

  socket.on('data', (chunk) => {
    log.debug(`<- ${peer} ${chunk.length}B`, chunk.toString('hex'));
    buf = Buffer.concat([buf, chunk]);
    const { frames, rest } = extractFrames(buf);
    buf = rest;
    for (const inner of frames) {
      try {
        const frame = decode(inner);
        frameCount++;
        const id = '0x' + frame.msgId.toString(16).padStart(4, '0');
        log.info(`<- ${peer} frame#${frameCount} ${id} phone=${frame.phone} serial=${frame.serial} bodyLen=${frame.body.length} v2019=${frame.versionFlag}`);
        log.hex(`   body[${id}]`, frame.body);
        handlers.handle(socket, frame);
      } catch (e) {
        log.warn(`parse_error ${peer}: ${e.message} hex=${inner.toString('hex')}`);
        store.messages.push({ ts: new Date().toISOString(), type: 'parse_error', error: e.message, hex: inner.toString('hex') });
      }
    }
  });
  socket.on('close', (hadErr) => {
    const dur = ((Date.now() - connectedAt) / 1000).toFixed(1);
    log.info(`- close   ${peer} after=${dur}s frames=${frameCount} hadErr=${hadErr}`);
  });
  socket.on('error', (e) => log.warn(`socket_error ${peer}: ${e.message}`));
  socket.on('end',   () => log.info(`  end-of-stream ${peer}`));
  socket.on('timeout', () => log.warn(`  timeout ${peer}`));
});

jt808.listen(JT808_PORT, () => log.info(`TCP listening on :${JT808_PORT}`));
jt808.on('error', (e) => log.error(`server error: ${e.message}`));

// ---------- Attachment TCP server ----------
attachmentServer.start(ATTACHMENT_PORT);

// ---------- FTP server ----------
const ftp = new FtpSrv({
  url: `ftp://0.0.0.0:${FTP_PORT}`,
  pasv_url: PUBLIC_IP,
  pasv_min: 30000,
  pasv_max: 30100,
  anonymous: true,
});
// FileSystem subclass: when device CWDs into a path that doesn't exist,
// auto-create the directory tree. The device uploads video/photo evidence to
// /Upload/<phone>/Video/<YYYY-MM-DD>/ and expects this to just work.
class AutoMkdirFs extends FileSystem {
  get(fileName) {
    const target = path.join(this.cwd, fileName || '.');
    const real = path.join(this.root, target);
    if (!fs.existsSync(real)) {
      try { fs.mkdirSync(real, { recursive: true }); flog.info(`auto-mkdir ${real}`); } catch {}
    }
    return super.get(fileName);
  }
  chdir(p) {
    const target = path.resolve('/', this.cwd, p || '.');
    const real = path.join(this.root, target);
    if (!fs.existsSync(real)) {
      try { fs.mkdirSync(real, { recursive: true }); flog.info(`auto-mkdir ${real}`); } catch {}
    }
    return super.chdir(p);
  }
}

ftp.on('login', ({ connection, username }, resolve) => {
  flog.info(`login user=${username} ip=${connection.ip}`);
  connection.on('STOR', (error, fileName) => {
    if (error) { flog.warn(`STOR error ${fileName}: ${error.message}`); return; }
    try {
      const stat = fs.statSync(fileName);
      const rel = path.relative(FTP_ROOT, fileName);
      const parts = rel.split(path.sep);   // e.g. ["Upload","806072880208","Video","2026-05-06","xyz.mp4"]
      const phone = parts[1] || username;
      const safe = `${phone}_${parts.slice(2).join('_')}`.replace(/[^A-Za-z0-9._-]/g, '_');
      const dest = path.join(MEDIA_DIR, safe);
      fs.copyFileSync(fileName, dest);
      flog.info(`STOR ok ${rel} size=${stat.size} -> media/${safe}`);
      store.media.push({ ts: new Date().toISOString(), source: 'ftp', phone, user: username, fname: path.basename(fileName), originalPath: rel, size: stat.size, path: dest });
      store.alerts.push({ ts: new Date().toISOString(), phone, type: 'video_uploaded', source: 'ftp', fname: path.basename(fileName), size: stat.size, originalPath: rel });
    } catch (e) { flog.warn(`STOR copy failed: ${e.message}`); }
  });
  connection.on('RETR', (err, fname) => flog.info(`RETR ${fname}${err ? ' ERR ' + err.message : ''}`));
  const fsImpl = new AutoMkdirFs(connection, { root: FTP_ROOT, cwd: '/' });
  resolve({ root: FTP_ROOT, fs: fsImpl });
});
ftp.listen().then(() => flog.info(`listening on :${FTP_PORT}, pasv ${PUBLIC_IP}:30000-30100`));

// ---------- HTTP API ----------
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use((req, _res, next) => { hlog.info(`${req.method} ${req.url} from ${req.ip}`); next(); });

app.get('/', (_, res) => res.json({
  ok: true,
  ports: { http: HTTP_PORT, jt808: JT808_PORT, attachment: ATTACHMENT_PORT, ftp: FTP_PORT },
  endpoints: ['/dashboard', '/events', '/messages', '/alerts', '/media', '/media/:filename', '/terminals'],
}));

app.get('/messages', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 5000);
  res.json(store.messages.list().slice(0, limit));
});

app.get('/alerts', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 5000);
  res.json(store.alerts.list().slice(0, limit));
});

app.get('/media', (_, res) => {
  const disk = fs.readdirSync(MEDIA_DIR).map((f) => {
    const st = fs.statSync(path.join(MEDIA_DIR, f));
    return { fname: f, size: st.size, mtime: st.mtime, url: `/media/${encodeURIComponent(f)}` };
  });
  res.json({ index: store.media.list(), files: disk });
});

app.get('/media/:filename', (req, res) => {
  const fp = path.join(MEDIA_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.sendFile(fp);
});

app.get('/terminals', (_, res) => {
  res.json([...store.terminals.values()].map(safeTerminal));
});

// /events — group alarms with their evidence files into one event per alarm.
// Joins on alarmNumber (the "<phone>-<timestamp>" tag we put in 0x9208).
const ALARM_TYPE_NAME = {
  // high byte = channel, low byte = sub-event
  '6401':'forward_collision', '6402':'lane_deviation', '6403':'close_distance',
  '6404':'pedestrian_collision', '6405':'frequent_lane_change', '6406':'road_sign_overrun',
  '6407':'obstacle', '6408':'driving_assist_state',
  '6501':'fatigue', '6502':'phone_call', '6503':'smoking', '6504':'distracted',
  '6505':'driver_abnormal', '6506':'no_seatbelt',
  '6601':'rear_approach', '6602':'left_approach', '6603':'right_approach',
};

function buildEvents() {
  const alerts = store.alerts.list().filter(a => a.type === 'attachment_request');
  const media = store.media.list();

  // Index media by alarmNumber, AND by the timestamp suffix in filenames so we can
  // group historical files (saved before alarmNumber was tracked) too.
  const tsKey = fname => {
    const m = fname && fname.match(/-(\d+)\.[^.]+$/);
    return m ? m[1] : null;
  };
  const mediaByAlarm = new Map();
  const mediaByTs = new Map();
  for (const m of media) {
    if (m.alarmNumber) {
      if (!mediaByAlarm.has(m.alarmNumber)) mediaByAlarm.set(m.alarmNumber, []);
      mediaByAlarm.get(m.alarmNumber).push(m);
    }
    const ts = tsKey(m.fname);
    if (ts) {
      if (!mediaByTs.has(ts)) mediaByTs.set(ts, []);
      mediaByTs.get(ts).push(m);
    }
  }

  // Start from alerts that have an alarmNumber (preferred — has lat/lon/event name).
  const out = [];
  const claimedAlarmNumbers = new Set();
  for (const a of alerts) {
    if (!a.alarmNumber) continue;
    const files = mediaByAlarm.get(a.alarmNumber) || [];
    const alarmType = files[0]?.alarmType;
    out.push({
      alarmNumber: a.alarmNumber,
      ts: a.ts,
      phone: a.phone,
      kind: a.alarmKind,
      eventName: (alarmType && ALARM_TYPE_NAME[alarmType.toLowerCase()]) || a.eventName,
      alarmType: alarmType ? '0x' + alarmType : undefined,
      deviceTime: a.location?.time,
      lat: a.location?.lat, lon: a.location?.lon,
      speed_kmh: a.location?.speed_kmh, direction: a.location?.direction,
      files: files.map(f => ({ fname: f.fname, fileType: f.fileType, size: f.bytes, url: `/media/${encodeURIComponent(path.basename(f.path))}` })),
    });
    claimedAlarmNumbers.add(a.alarmNumber);
  }

  // Then add any media-only events (no alert record — older alarms before alarmNumber tracking).
  for (const [ts, files] of mediaByTs) {
    const sample = files[0];
    if (sample.alarmNumber && claimedAlarmNumbers.has(sample.alarmNumber)) continue;
    const alarmType = files[0]?.alarmType;
    out.push({
      alarmNumber: sample.alarmNumber || `unknown-${ts}`,
      ts: sample.ts,
      phone: sample.phone,
      kind: alarmType?.startsWith('64') ? 'ADAS' : alarmType?.startsWith('65') ? 'DSM' : alarmType?.startsWith('66') ? 'BSD' : undefined,
      eventName: alarmType && ALARM_TYPE_NAME[alarmType.toLowerCase()],
      alarmType: alarmType ? '0x' + alarmType : undefined,
      deviceTime: undefined,
      lat: undefined, lon: undefined, speed_kmh: undefined, direction: undefined,
      files: files.map(f => ({ fname: f.fname, fileType: f.fileType, size: f.bytes, url: `/media/${encodeURIComponent(path.basename(f.path))}` })),
    });
  }

  // Dedupe by alarmNumber (alerts can have multiple completion records).
  const seen = new Set();
  const unique = [];
  for (const e of out) {
    if (seen.has(e.alarmNumber)) continue;
    seen.add(e.alarmNumber);
    unique.push(e);
  }
  unique.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  return unique;
}

app.get('/events', (_, res) => res.json(buildEvents()));

app.get('/dashboard', (_, res) => {
  res.render('events', { events: buildEvents() });
});

function safeTerminal(t) {
  if (!t) return null;
  const peer = t.socket && t.socket.remoteAddress
    ? `${t.socket.remoteAddress}:${t.socket.remotePort}` : null;
  return { phone: t.phone, lastSeen: t.lastSeen, authCode: t.authCode, registered: t.registered, peer };
}

app.get('/debug/:phone', (req, res) => {
  const p = req.params.phone;
  res.json({
    terminal: safeTerminal(store.terminals.get(p)),
    messages: store.messages.list().filter(m => m.phone === p).slice(0, 50),
    alerts:   store.alerts.list().filter(m => m.phone === p).slice(0, 50),
    media:    store.media.list().filter(m => m.phone === p).slice(0, 50),
  });
});

app.listen(HTTP_PORT, () => {
  hlog.info(`listening on :${HTTP_PORT}`);
  console.log('---');
  console.log(`Public IP: ${PUBLIC_IP}`);
  console.log(`Configure device: server IP=${PUBLIC_IP}, JT808 TCP port=${JT808_PORT}`);
  console.log(`Attachment server (auto-advertised via 0x9208): ${PUBLIC_IP}:${ATTACHMENT_PORT}`);
  console.log(`FTP: ${PUBLIC_IP}:${FTP_PORT} (anonymous, files copied to ./media)`);
  console.log(`Log level: ${process.env.LOG_LEVEL || 'debug'} — set LOG_LEVEL=info to quiet hex dumps`);
});

process.on('uncaughtException',  (e) => log.error(`uncaughtException: ${e.stack || e}`));
process.on('unhandledRejection', (e) => log.error(`unhandledRejection: ${e && e.stack || e}`));
