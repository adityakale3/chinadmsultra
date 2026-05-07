// Alarm-attachment receiver (JT/T 1078).
// Signaling messages 0x1210 / 0x1211 / 0x1212 use JT808 framing (0x7e + escape + xor).
// The payload bitstream packets use a raw 64-byte header starting with 0x30 0x31 0x63 0x64.

const net = require('net');
const fs = require('fs');
const path = require('path');
const { extractFrames, decode, encode } = require('./jt808/codec');
const store = require('./store');
const { make } = require('./logger');
const log = make('ATTACH');

const MEDIA_DIR = path.resolve(__dirname, 'media');
const BITSTREAM_MAGIC = Buffer.from([0x30, 0x31, 0x63, 0x64]);

let serverSerial = 0;
const nextSerial = () => (serverSerial = (serverSerial + 1) & 0xffff);

function ensureDir() { if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true }); }

function genericResponse(phone, replySerial, replyId, version2019) {
  const body = Buffer.alloc(5);
  body.writeUInt16BE(replySerial, 0);
  body.writeUInt16BE(replyId, 2);
  body[4] = 0;
  return encode({ msgId: 0x8001, phone, serial: nextSerial(), body, version2019 });
}

// 0x9212 file-upload-complete response: nameLen(1) name fileType(1) result(1) packetCount(4)?
function file9212(phone, fileName, fileType, version2019) {
  const nm = Buffer.from(fileName, 'utf8');
  const body = Buffer.alloc(1 + nm.length + 1 + 1 + 4);
  let p = 0;
  body[p++] = nm.length;
  nm.copy(body, p); p += nm.length;
  body[p++] = fileType;
  body[p++] = 0; // 0 = done, no retransmit
  body.writeUInt32BE(0, p);
  return encode({ msgId: 0x9212, phone, serial: nextSerial(), body, version2019 });
}

function start(port) {
  ensureDir();
  const server = net.createServer((socket) => {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    log.info(`+ connect ${peer}`);
    socket.setKeepAlive(true, 30000);
    let buf = Buffer.alloc(0);
    const openFiles = new Map(); // fileName -> { fd, path, size, written }
    let phone = 'unknown';
    let version2019 = false;

    socket.on('data', (chunk) => {
      log.debug(`<- ${peer} ${chunk.length}B`, chunk.length < 256 ? chunk.toString('hex') : chunk.slice(0,128).toString('hex')+'...(truncated)');
      buf = Buffer.concat([buf, chunk]);

      // Loop: a single TCP read may contain framed signaling AND raw bitstream packets.
      // Strategy: if buffer starts with 0x7e, parse one signaling frame; else if it
      // starts with bitstream magic, parse one bitstream packet; otherwise drop a byte.
      // eslint-disable-next-line no-constant-condition
      while (buf.length > 0) {
        if (buf[0] === 0x7e) {
          // find the closing 0x7e
          const end = buf.indexOf(0x7e, 1);
          if (end < 0) return; // wait for more
          const inner = buf.slice(1, end);
          buf = buf.slice(end + 1);
          if (inner.length === 0) continue;
          try {
            const frame = decode(inner);
            phone = frame.phone;
            version2019 = frame.versionFlag;
            handleSignaling(socket, frame, openFiles, version2019);
          } catch (e) {
            store.messages.push({ ts: new Date().toISOString(), type: 'attach_signal_err', error: e.message, hex: inner.toString('hex') });
          }
          continue;
        }
        // bitstream packet
        const idx = buf.indexOf(BITSTREAM_MAGIC);
        if (idx < 0) { buf = Buffer.alloc(0); break; }
        if (idx > 0) buf = buf.slice(idx);
        // header: magic(4) + fileName(50) + dataOffset(4) + length(4) = 62
        if (buf.length < 62) return;
        const fileName = buf.slice(4, 54).toString('utf8').replace(/\0+$/, '').trim();
        const dataOffset = buf.readUInt32BE(54);
        const length = buf.readUInt32BE(58);
        if (buf.length < 62 + length) return; // wait
        const payload = buf.slice(62, 62 + length);
        buf = buf.slice(62 + length);
        writeChunk(phone, fileName, dataOffset, payload, openFiles);
      }
    });

    socket.on('close', () => {
      for (const [, f] of openFiles) try { fs.closeSync(f.fd); } catch {}
      log.info(`- close ${peer} openFiles=${openFiles.size}`);
    });
    socket.on('error', (e) => log.warn(`socket_error ${peer}: ${e.message}`));
  });

  server.listen(port, () => log.info(`TCP listening on :${port}`));
  server.on('error', (e) => log.error(`server error: ${e.message}`));
  return server;
}

function buildRegisterAck(phone, replySerial, version2019) {
  const ac = Buffer.from('ATTACH' + Date.now().toString(36), 'utf8');
  const body = Buffer.alloc(3 + ac.length);
  body.writeUInt16BE(replySerial, 0);
  body[2] = 0;
  ac.copy(body, 3);
  return encode({ msgId: 0x8100, phone, serial: nextSerial(), body, version2019 });
}

function handleSignaling(socket, frame, openFiles, version2019) {
  const { msgId, phone, serial, body } = frame;
  switch (msgId) {
    case 0x0100: { // device pre-alarm idle keep-alive on the attachment port
      socket.write(buildRegisterAck(phone, serial, version2019));
      log.debug(`pre-alarm register from ${phone} acked`);
      return;
    }
    case 0x0102: case 0x0002: { // auth / heartbeat keep-alives on the attach port
      socket.write(genericResponse(phone, serial, msgId, version2019));
      return;
    }
    case 0x1210: {
      // termId(7) alarmId(16) alarmNumber(32) infoType(1) attachmentCount(1) [name fileSize ...]
      let p = 0;
      const termId = body.slice(p, p + 7).toString('ascii').replace(/\0+$/, ''); p += 7;
      const alarmId = body.slice(p, p + 16).toString('hex'); p += 16;
      const alarmNumber = body.slice(p, p + 32).toString('hex'); p += 32;
      const infoType = body[p++]; const count = body[p++];
      const files = [];
      for (let i = 0; i < count && p < body.length; i++) {
        const nl = body[p++];
        const fname = body.slice(p, p + nl).toString('utf8'); p += nl;
        const fsize = body.readUInt32BE(p); p += 4;
        files.push({ fname, fsize });
      }
      socket.write(genericResponse(phone, serial, msgId, version2019));
      log.info(`1210 phone=${phone} alarmId=${alarmId} files=${JSON.stringify(files)}`);
      store.messages.push({ ts: new Date().toISOString(), type: 'attach_1210', phone, termId, alarmId, alarmNumber, infoType, files });
      return;
    }
    case 0x1211: {
      // file info: nameLen(1) name fileType(1) fileSize(4)
      const nl = body[0];
      const fname = body.slice(1, 1 + nl).toString('utf8');
      const fileType = body[1 + nl];
      const fileSize = body.readUInt32BE(2 + nl);
      socket.write(genericResponse(phone, serial, msgId, version2019));
      log.info(`1211 phone=${phone} starting "${fname}" type=${fileType} size=${fileSize}`);
      store.messages.push({ ts: new Date().toISOString(), type: 'attach_1211', phone, fname, fileType, fileSize });
      return;
    }
    case 0x1212: {
      // file upload complete: nameLen(1) name fileType(1) fileSize(4)
      const nl = body[0];
      const fname = body.slice(1, 1 + nl).toString('utf8');
      const fileType = body[1 + nl];
      // close file if open
      const safe = path.join(MEDIA_DIR, fname.replace(/[^A-Za-z0-9._-]/g, '_'));
      const f = openFiles.get(fname);
      if (f) { try { fs.closeSync(f.fd); } catch {}; openFiles.delete(fname); }
      socket.write(genericResponse(phone, serial, msgId, version2019));
      socket.write(file9212(phone, fname, fileType, version2019));
      const wrote = f ? f.written : 0;
      log.info(`1212 phone=${phone} done "${fname}" wroteBytes=${wrote} -> ${safe}`);
      store.media.push({ ts: new Date().toISOString(), source: 'alarm_attachment', phone, fname, fileType, path: safe, bytes: wrote });
      return;
    }
    default:
      log.warn(`signal phone=${phone} unhandled 0x${msgId.toString(16)}`);
      socket.write(genericResponse(phone, serial, msgId, version2019));
  }
}

function writeChunk(phone, fileName, offset, payload, openFiles) {
  const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, '_');
  const fp = path.join(MEDIA_DIR, safeName);
  let f = openFiles.get(fileName);
  if (!f) {
    const fd = fs.openSync(fp, 'a+');
    f = { fd, path: fp, written: 0 };
    openFiles.set(fileName, f);
  }
  fs.writeSync(f.fd, payload, 0, payload.length, offset);
  f.written += payload.length;
  log.debug(`stream "${fileName}" off=${offset} len=${payload.length} total=${f.written}`);
}

module.exports = { start };
