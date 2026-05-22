// Platform → device command dispatch with 0x0001 ACK tracking.
//
// Public:
//   sendCommand(phone, msgId, body, opts)
//     → Promise<{ result, resultName, replySerial }>  resolves on 0x0001 ACK
//     → rejects on timeout / device offline / send error
//   registerAck(phone, replySerial, replyId, result)  ← call from handlers.js 0x0001 case
//
// Each command uses its own monotonic serial; we key pending acks by
// `${phone}:${serial}:${msgId}`. The device echoes back the original serial+msgId
// in its 0x0001 general response so we can correlate.

const { encode } = require('./jt808/codec');
const store = require('./store');
const { make } = require('./logger');
const log = make('CMD');

let serverSerial = 0;
const nextSerial = () => (serverSerial = (serverSerial + 1) & 0xffff);

const pending = new Map(); // key → {resolve, reject, timer}
const keyOf = (phone, replySerial, replyId) => `${phone}:${replySerial}:${replyId}`;

// Ring of last commands sent (most recent first when listed).
const HISTORY_MAX = 100;
const history = [];
function recordCommandStart(entry) {
  history.unshift(entry);
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
}
function recordCommandAck(phone, replySerial, replyId, result, resultName) {
  for (const h of history) {
    if (h.phone === phone && h.serial === replySerial && h.msgId === replyId && !h.ack) {
      h.ack = { ts: new Date().toISOString(), result, resultName }; break;
    }
  }
}
function listHistory() { return history.slice(); }

function registerAck(phone, replySerial, replyId, result) {
  const resultName = ['ok','fail','msg-error','not-supported'][result] || `r${result}`;
  recordCommandAck(phone, replySerial, replyId, result, resultName);
  const k = keyOf(phone, replySerial, replyId);
  const slot = pending.get(k);
  if (!slot) return false;
  clearTimeout(slot.timer);
  pending.delete(k);
  log.info(`ACK matched ${k} result=${resultName}`);
  slot.resolve({ result, resultName, replySerial });
  return true;
}

function sendCommand(phone, msgId, body, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    const term = store.terminals.get(phone);
    if (!term || !term.socket || term.socket.destroyed) {
      return reject(new Error(`device ${phone} not connected`));
    }
    const serial = nextSerial();
    const version2019 = term.version2019 ?? true;
    const buf = encode({ msgId, phone, serial, body, version2019 });
    const k = keyOf(phone, serial, msgId);
    const timer = setTimeout(() => {
      if (pending.delete(k)) reject(new Error(`ack timeout for ${k}`));
    }, timeoutMs);
    pending.set(k, { resolve, reject, timer });
    const histEntry = {
      ts: new Date().toISOString(),
      phone, msgId, msgIdHex: '0x' + msgId.toString(16).padStart(4,'0'),
      serial, bodyHex: body.toString('hex'), label: opts.label || '',
      ack: null,
    };
    recordCommandStart(histEntry);
    try {
      term.socket.write(buf);
      log.info(`-> phone=${phone} msgId=${histEntry.msgIdHex} serial=${serial} bodyLen=${body.length}${opts.label ? ' ('+opts.label+')' : ''}`);
    } catch (e) {
      pending.delete(k); clearTimeout(timer);
      histEntry.ack = { ts: new Date().toISOString(), result: -1, resultName: 'write-error', error: e.message };
      return reject(new Error(`socket write failed: ${e.message}`));
    }
  });
}

// Helper: build a generic 0x8103 Set Terminal Parameters body.
//   params: [{ id: 0x0064, value: Buffer|string|number }, ...]
// For string values we encode UTF-8. For numbers we encode 4-byte big-endian.
function buildSetParamsBody(params) {
  const head = Buffer.from([params.length]);
  const chunks = params.map(({ id, value }) => {
    let valBuf;
    if (Buffer.isBuffer(value)) valBuf = value;
    else if (typeof value === 'string') valBuf = Buffer.from(value, 'utf8');
    else if (typeof value === 'number') {
      valBuf = Buffer.alloc(4); valBuf.writeUInt32BE(value >>> 0, 0);
    } else throw new Error(`unsupported param value type: ${typeof value}`);
    const out = Buffer.alloc(5 + valBuf.length);
    out.writeUInt32BE(id, 0);
    out[4] = valBuf.length & 0xff;
    valBuf.copy(out, 5);
    return out;
  });
  return Buffer.concat([head, ...chunks]);
}

// Send a single 0x8103 set-params command and wait for the device's ACK.
async function setParams(phone, params, opts) {
  const body = buildSetParamsBody(params);
  return sendCommand(phone, 0x8103, body, opts);
}

// Send a 0x8900 transparent / passthrough frame.
//   subType: byte at offset 0 of the body
//   payload: Buffer or hex string of the remaining bytes
async function transparent(phone, subType, payload, opts) {
  const pBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '', 'hex');
  const body = Buffer.concat([Buffer.from([subType & 0xff]), pBuf]);
  return sendCommand(phone, 0x8900, body, opts);
}

// Send a 0x8105 terminal-control command. action byte values per JT808 spec:
//   0x01 wireless upgrade  0x02 connect server  0x03 shutdown
//   0x04 reboot            0x05 factory reset   0x64 close comms  0x65 open comms
async function terminalControl(phone, action, paramStr = '', opts) {
  const body = Buffer.concat([Buffer.from([action & 0xff]), Buffer.from(paramStr, 'utf8')]);
  return sendCommand(phone, 0x8105, body, opts);
}

// Send a 0x8300 text message. flagBits: 0x01 urgent, 0x02 display, 0x08 TTS read,
// 0x10 ad-screen, 0x20 CAN-fault.
async function textMessage(phone, flagBits, text, opts) {
  const body = Buffer.concat([Buffer.from([flagBits & 0xff]), Buffer.from(text, 'utf8')]);
  return sendCommand(phone, 0x8300, body, opts);
}

function stats() {
  return { pending: pending.size };
}

module.exports = {
  sendCommand, registerAck,
  setParams, transparent, terminalControl, textMessage,
  buildSetParamsBody, stats, listHistory,
};
