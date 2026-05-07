const { encode } = require('./codec');
const { parseLocation } = require('./parse-location');
const store = require('../store');

const ATTACHMENT_HOST = process.env.ATTACHMENT_HOST || '13.206.186.1';
const ATTACHMENT_TCP_PORT = Number(process.env.ATTACHMENT_TCP_PORT || 7612);

let serverSerial = 0;
const nextSerial = () => (serverSerial = (serverSerial + 1) & 0xffff);

// 0x8001 platform general response: replySerial(WORD) replyId(WORD) result(BYTE)
function buildGeneralResponse(phone, replySerial, replyId, result, version2019) {
  const body = Buffer.alloc(5);
  body.writeUInt16BE(replySerial, 0);
  body.writeUInt16BE(replyId, 2);
  body[4] = result;
  return encode({ msgId: 0x8001, phone, serial: nextSerial(), body, version2019 });
}

// 0x8100 register response: replySerial(WORD) result(BYTE) authCode(STRING, on success)
function buildRegisterResponse(phone, replySerial, result, authCode, version2019) {
  const ac = Buffer.from(authCode, 'utf8');
  const body = Buffer.alloc(3 + ac.length);
  body.writeUInt16BE(replySerial, 0);
  body[2] = result;
  ac.copy(body, 3);
  return encode({ msgId: 0x8100, phone, serial: nextSerial(), body, version2019 });
}

// 0x9208 alarm-attachment upload command:
//   ipLen(1) ip(STRING) tcpPort(WORD) udpPort(WORD) alarmId(16B) alarmNumber(32B) reserved(16B)
function build9208(phone, alarmIdBuf, alarmNumber32, version2019) {
  const ip = Buffer.from(ATTACHMENT_HOST, 'utf8');
  const body = Buffer.alloc(1 + ip.length + 2 + 2 + 16 + 32 + 16);
  let p = 0;
  body[p++] = ip.length;
  ip.copy(body, p); p += ip.length;
  body.writeUInt16BE(ATTACHMENT_TCP_PORT, p); p += 2;
  body.writeUInt16BE(0, p); p += 2;
  alarmIdBuf.copy(body, p, 0, Math.min(16, alarmIdBuf.length)); p += 16;
  alarmNumber32.copy(body, p, 0, Math.min(32, alarmNumber32.length)); p += 32;
  // reserved 16 bytes left as zero
  return encode({ msgId: 0x9208, phone, serial: nextSerial(), body, version2019 });
}

function record(kind, entry) {
  store.messages.push({ ts: new Date().toISOString(), ...entry });
  if (kind === 'alert') store.alerts.push({ ts: new Date().toISOString(), ...entry });
}

function handle(socket, frame) {
  const { msgId, phone, serial, body, versionFlag, raw } = frame;
  const v = versionFlag;
  const idHex = '0x' + msgId.toString(16).padStart(4, '0');
  const base = { phone, msgId: idHex, serial, raw: raw.toString('hex') };

  // remember terminal
  const term = store.terminals.get(phone) || { phone };
  term.socket = socket;
  term.lastSeen = new Date().toISOString();
  store.terminals.set(phone, term);

  switch (msgId) {
    case 0x0100: { // register
      const authCode = 'AUTH' + Date.now().toString(36);
      term.authCode = authCode;
      term.registered = true;
      socket.write(buildRegisterResponse(phone, serial, 0, authCode, v));
      record('msg', { ...base, type: 'register', parsed: { authCode } });
      return;
    }
    case 0x0102: { // auth
      socket.write(buildGeneralResponse(phone, serial, msgId, 0, v));
      record('msg', { ...base, type: 'auth', parsed: { authBody: body.toString('utf8') } });
      return;
    }
    case 0x0002: { // heartbeat
      socket.write(buildGeneralResponse(phone, serial, msgId, 0, v));
      record('msg', { ...base, type: 'heartbeat' });
      return;
    }
    case 0x0200: { // location
      const parsed = parseLocation(body);
      socket.write(buildGeneralResponse(phone, serial, msgId, 0, v));

      const adasDsmBsd = (parsed.extras || []).filter(x => x.kind);
      const hasAlarm = (parsed.alarms && parsed.alarms.length) || adasDsmBsd.length;
      record(hasAlarm ? 'alert' : 'msg', { ...base, type: 'location', parsed });

      // For each ADAS/DSM/BSD alarm, request the attachment upload
      for (const ev of adasDsmBsd) {
        if (!ev.alarmIdentification) continue;
        // Build 16B alarm-id buffer = the original last-16 bytes from the additional item
        // We don't have it directly; reconstruct from termId(7) + bcd time would be lossy.
        // Pull it directly from body: search for the extra by id.
        const alarmIdBuf = extractAlarmIdBytes(body, ev.id);
        if (!alarmIdBuf) continue;
        const alarmNumber32 = Buffer.alloc(32);
        Buffer.from(`${phone}-${Date.now()}`).copy(alarmNumber32);
        socket.write(build9208(phone, alarmIdBuf, alarmNumber32, v));
        record('alert', {
          phone, type: 'attachment_request', alarmKind: ev.kind,
          eventName: ev.eventName, alarmIdentification: ev.alarmIdentification,
        });
      }
      return;
    }
    case 0x0704: { // bulk locations
      socket.write(buildGeneralResponse(phone, serial, msgId, 0, v));
      record('msg', { ...base, type: 'bulk_location', parsed: { hex: body.toString('hex') } });
      return;
    }
    case 0x0801: case 0x0800: case 0x0805: { // legacy multimedia
      socket.write(buildGeneralResponse(phone, serial, msgId, 0, v));
      record('alert', { ...base, type: 'multimedia', parsed: { hex: body.toString('hex') } });
      return;
    }
    default: {
      socket.write(buildGeneralResponse(phone, serial, msgId, 0, v));
      record('msg', { ...base, type: 'unknown', parsed: { hex: body.toString('hex') } });
    }
  }
}

// Walk TLV extras and return the raw last-16 bytes of a given id (for 0x64/0x65/0x66).
function extractAlarmIdBytes(locationBody, idHex) {
  const id = parseInt(idHex, 16);
  let i = 28;
  while (i + 2 <= locationBody.length) {
    const tid = locationBody[i]; const len = locationBody[i + 1];
    if (i + 2 + len > locationBody.length) break;
    if (tid === id) {
      const v = locationBody.slice(i + 2, i + 2 + len);
      return v.slice(v.length - 16);
    }
    i += 2 + len;
  }
  return null;
}

module.exports = { handle };
