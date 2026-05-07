const net = require('net');
const fs = require('fs');
const path = require('path');
const express = require('express');
const FtpSrv = require('ftp-srv');

const { extractFrames, decode } = require('./jt808/codec');
const handlers = require('./jt808/handlers');
const attachmentServer = require('./attachment-server');
const store = require('./store');

const HTTP_PORT       = Number(process.env.HTTP_PORT       || 3000);
const JT808_PORT      = Number(process.env.JT808_PORT      || 7611);
const ATTACHMENT_PORT = Number(process.env.ATTACHMENT_PORT || 7612);
const FTP_PORT        = Number(process.env.FTP_PORT        || 21);
const PUBLIC_IP       = process.env.PUBLIC_IP || '13.206.186.1';

const MEDIA_DIR = path.resolve(__dirname, 'media');
const FTP_ROOT  = path.resolve(__dirname, 'ftp');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
if (!fs.existsSync(FTP_ROOT))  fs.mkdirSync(FTP_ROOT,  { recursive: true });

// ---------- JT808 TCP server ----------
const jt808 = net.createServer((socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[JT808] connect ${peer}`);
  socket.setKeepAlive(true, 30000);
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const { frames, rest } = extractFrames(buf);
    buf = rest;
    for (const inner of frames) {
      try {
        const frame = decode(inner);
        handlers.handle(socket, frame);
      } catch (e) {
        store.messages.push({ ts: new Date().toISOString(), type: 'parse_error', error: e.message, hex: inner.toString('hex') });
      }
    }
  });
  socket.on('close', () => console.log(`[JT808] close ${peer}`));
  socket.on('error', (e) => console.log(`[JT808] err ${peer} ${e.message}`));
});

jt808.listen(JT808_PORT, () => console.log(`[JT808] TCP listening on :${JT808_PORT}`));

// ---------- Attachment TCP server ----------
attachmentServer.start(ATTACHMENT_PORT);

// ---------- FTP server (for 0x9206 file-upload-instruction) ----------
const ftp = new FtpSrv({
  url: `ftp://0.0.0.0:${FTP_PORT}`,
  pasv_url: PUBLIC_IP,
  pasv_min: 30000,
  pasv_max: 30100,
  anonymous: true,
});
ftp.on('login', ({ connection, username }, resolve) => {
  console.log(`[FTP] login user=${username}`);
  connection.on('STOR', (error, fileName) => {
    if (!error) {
      const stat = fs.statSync(fileName);
      const dest = path.join(MEDIA_DIR, path.basename(fileName));
      try { fs.copyFileSync(fileName, dest); } catch {}
      store.media.push({ ts: new Date().toISOString(), source: 'ftp', user: username, fname: path.basename(fileName), size: stat.size, path: dest });
    }
  });
  resolve({ root: FTP_ROOT });
});
ftp.listen().then(() => console.log(`[FTP]   listening on :${FTP_PORT}, pasv ${PUBLIC_IP}:30000-30100`));

// ---------- HTTP API ----------
const app = express();
app.use(express.json());

app.get('/', (_, res) => res.json({
  ok: true,
  ports: { http: HTTP_PORT, jt808: JT808_PORT, attachment: ATTACHMENT_PORT, ftp: FTP_PORT },
  endpoints: ['/messages', '/alerts', '/media', '/media/:filename', '/terminals'],
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
  res.json([...store.terminals.values()].map(({ socket, ...rest }) => rest));
});

app.listen(HTTP_PORT, () => {
  console.log(`[HTTP]  listening on :${HTTP_PORT}`);
  console.log(`---`);
  console.log(`Public IP: ${PUBLIC_IP}`);
  console.log(`Configure device: server IP=${PUBLIC_IP}, JT808 TCP port=${JT808_PORT}`);
  console.log(`Attachment server (auto-advertised via 0x9208): ${PUBLIC_IP}:${ATTACHMENT_PORT}`);
  console.log(`FTP: ${PUBLIC_IP}:${FTP_PORT} (anonymous, files copied to ./media)`);
});
