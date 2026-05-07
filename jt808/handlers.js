const { encode } = require('./codec');
const { parseLocation, parseBulkLocation } = require('./parse-location');
const store = require('../store');
const { make } = require('../logger');
const log = make('JT808');

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

// 0x8103 Set Terminal Parameters. body: paramCount(BYTE) [paramId(DWORD) len(BYTE) value]*
// Heartbeat interval = paramId 0x0001 (DWORD seconds). Default per spec is 60 s.
// We push HEARTBEAT_INTERVAL (default 20 s) to defeat carrier NAT idle-timeout.
const HEARTBEAT_INTERVAL = Number(process.env.HEARTBEAT_INTERVAL || 20);
const TCP_RESPONSE_TIMEOUT = Number(process.env.TCP_RESPONSE_TIMEOUT || 15);
const TCP_RECONNECT_TIMES = Number(process.env.TCP_RECONNECT_TIMES || 3);

function buildSetParams(phone, version2019) {
  const params = [
    [0x0001, HEARTBEAT_INTERVAL],     // heartbeat interval (s)
    [0x001a, TCP_RESPONSE_TIMEOUT],   // tcp response timeout (s)
    [0x001b, TCP_RECONNECT_TIMES],    // tcp reconnect attempts
  ];
  const head = Buffer.from([params.length]);
  const chunks = params.map(([id, val]) => {
    const b = Buffer.alloc(9);
    b.writeUInt32BE(id, 0);
    b[4] = 4;
    b.writeUInt32BE(val, 5);
    return b;
  });
  return encode({ msgId: 0x8103, phone, serial: nextSerial(), body: Buffer.concat([head, ...chunks]), version2019 });
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

function send(socket, label, buf) {
  socket.write(buf);
  log.debug(`-> ${label}`, buf.toString('hex'));
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
      send(socket, `0x8100 register-ack phone=${phone}`, buildRegisterResponse(phone, serial, 0, authCode, v));
      log.info(`REGISTER phone=${phone} -> authCode=${authCode}`);
      record('msg', { ...base, type: 'register', parsed: { authCode } });
      return;
    }
    case 0x0102: { // auth
      send(socket, `0x8001 auth-ack phone=${phone}`, buildGeneralResponse(phone, serial, msgId, 0, v));
      log.info(`AUTH phone=${phone} body="${body.toString('utf8').replace(/\0/g,'').replace(/[^\x20-\x7e]/g,'.')}"`);
      record('msg', { ...base, type: 'auth', parsed: { authBody: body.toString('utf8') } });
      // Push shorter heartbeat interval so carrier NAT doesn't idle-timeout the connection.
      send(socket, `0x8103 set-params phone=${phone} heartbeat=${HEARTBEAT_INTERVAL}s`, buildSetParams(phone, v));
      log.info(`SET_PARAMS phone=${phone} heartbeat=${HEARTBEAT_INTERVAL}s tcpRespTimeout=${TCP_RESPONSE_TIMEOUT}s reconnect=${TCP_RECONNECT_TIMES}`);
      return;
    }
    case 0x0001: { // terminal general response — ack to one of our platform messages
      // body: replySerial(WORD) replyId(WORD) result(BYTE: 0=ok 1=fail 2=msg-error 3=not-supported)
      if (body.length >= 5) {
        const replySerial = body.readUInt16BE(0);
        const replyId = body.readUInt16BE(2);
        const result = body[4];
        const resultName = ['ok','fail','msg-error','not-supported'][result] || `r${result}`;
        log.info(`ACK phone=${phone} replyTo=0x${replyId.toString(16).padStart(4,'0')} serial=${replySerial} result=${resultName}`);
        record('msg', { ...base, type: 'ack', parsed: { replyId: '0x' + replyId.toString(16).padStart(4,'0'), replySerial, result, resultName } });
      }
      return; // no platform reply for a terminal general response
    }
    case 0x0002: { // heartbeat
      send(socket, `0x8001 heartbeat-ack phone=${phone}`, buildGeneralResponse(phone, serial, msgId, 0, v));
      log.info(`HEARTBEAT phone=${phone}`);
      record('msg', { ...base, type: 'heartbeat' });
      return;
    }
    case 0x0200: { // location
      const parsed = parseLocation(body);
      send(socket, `0x8001 0x0200-ack phone=${phone}`, buildGeneralResponse(phone, serial, msgId, 0, v));
      log.info(`LOCATION phone=${phone} lat=${parsed.lat} lon=${parsed.lon} spd=${parsed.speed_kmh} dir=${parsed.direction} t=${parsed.time} alarms=${(parsed.alarms||[]).join(',') || 'none'}`);

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
        send(socket, `0x9208 attach-req phone=${phone} kind=${ev.kind} ev=${ev.eventName}`, build9208(phone, alarmIdBuf, alarmNumber32, v));
        log.info(`ALARM ${ev.kind} ${ev.eventName} phone=${phone} -> requested attachment upload`);
        record('alert', {
          phone, type: 'attachment_request', alarmKind: ev.kind,
          eventName: ev.eventName, alarmIdentification: ev.alarmIdentification,
        });
      }
      return;
    }
    case 0x0704: { // bulk locations
      send(socket, `0x8001 0x0704-ack phone=${phone}`, buildGeneralResponse(phone, serial, msgId, 0, v));
      const parsed = parseBulkLocation(body);
      log.info(`BULK_LOC phone=${phone} count=${parsed.count} firstLat=${parsed.items?.[0]?.lat} firstLon=${parsed.items?.[0]?.lon} t=${parsed.items?.[0]?.time}`);
      const anyAlarm = (parsed.items || []).some(it => (it.alarms && it.alarms.length) || (it.extras || []).some(x => x.kind));
      record(anyAlarm ? 'alert' : 'msg', { ...base, type: 'bulk_location', parsed });
      // If any inner item carries an ADAS/DSM/BSD extra, request the video evidence.
      for (const it of parsed.items || []) {
        const events = (it.extras || []).filter(x => x.kind);
        if (!events.length) continue;
        // Re-extract raw extras region from inside the bulk body is messy; re-walk the inner item buffer instead.
        // We don't have direct access here, so we trigger the request using a synthesized alarmId.
        for (const ev of events) {
          if (!ev.alarmIdentification) continue;
          const alarmIdBuf = Buffer.alloc(16);
          Buffer.from(ev.alarmIdentification.termId.padEnd(7, '\0')).copy(alarmIdBuf, 0, 0, 7);
          const alarmNumber32 = Buffer.alloc(32);
          Buffer.from(`${phone}-${Date.now()}`).copy(alarmNumber32);
          send(socket, `0x9208 attach-req phone=${phone} kind=${ev.kind} ev=${ev.eventName}`, build9208(phone, alarmIdBuf, alarmNumber32, v));
          log.info(`ALARM ${ev.kind} ${ev.eventName} phone=${phone} (in bulk) -> requested attachment upload`);
          record('alert', {
            phone, type: 'attachment_request', alarmKind: ev.kind,
            eventName: ev.eventName, alarmIdentification: ev.alarmIdentification,
          });
        }
      }
      return;
    }
    case 0x0900: { // ULV transparent data uplink
      send(socket, `0x8001 0x0900-ack phone=${phone}`, buildGeneralResponse(phone, serial, msgId, 0, v));
      const subType = body[0];
      log.info(`TRANSPARENT phone=${phone} sub=0x${subType.toString(16)} hex=${body.toString('hex')}`);
      record('msg', { ...base, type: 'transparent', parsed: { subType: '0x' + subType.toString(16), hex: body.toString('hex') } });
      return;
    }
    case 0x0801: case 0x0800: case 0x0805: { // legacy multimedia
      send(socket, `0x8001 multimedia-ack phone=${phone} ${idHex}`, buildGeneralResponse(phone, serial, msgId, 0, v));
      log.info(`MULTIMEDIA phone=${phone} ${idHex} bodyLen=${body.length}`);
      record('alert', { ...base, type: 'multimedia', parsed: { hex: body.toString('hex') } });
      return;
    }
    default: {
      send(socket, `0x8001 default-ack ${idHex} phone=${phone}`, buildGeneralResponse(phone, serial, msgId, 0, v));
      log.warn(`UNHANDLED ${idHex} phone=${phone} bodyHex=${body.toString('hex')}`);
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
