// JT808 framing: 0x7e <escaped(header+body+xor)> 0x7e
// Escapes: 0x7e -> 0x7d 0x02 ; 0x7d -> 0x7d 0x01

function unescape(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x7d && buf[i + 1] === 0x02) { out.push(0x7e); i++; }
    else if (buf[i] === 0x7d && buf[i + 1] === 0x01) { out.push(0x7d); i++; }
    else out.push(buf[i]);
  }
  return Buffer.from(out);
}

function escape(buf) {
  const out = [];
  for (const b of buf) {
    if (b === 0x7e) { out.push(0x7d, 0x02); }
    else if (b === 0x7d) { out.push(0x7d, 0x01); }
    else out.push(b);
  }
  return Buffer.from(out);
}

function xor(buf) {
  let c = 0;
  for (const b of buf) c ^= b;
  return c;
}

// Pull complete frames out of a rolling buffer. Returns { frames, rest }.
function extractFrames(buffer) {
  const frames = [];
  let rest = buffer;
  while (true) {
    const start = rest.indexOf(0x7e);
    if (start < 0) { rest = Buffer.alloc(0); break; }
    const end = rest.indexOf(0x7e, start + 1);
    if (end < 0) { rest = rest.slice(start); break; }
    if (end === start + 1) { rest = rest.slice(end); continue; } // empty
    const inner = rest.slice(start + 1, end);
    frames.push(inner);
    rest = rest.slice(end + 1);
  }
  return { frames, rest };
}

function bcdToStr(buf) {
  let s = '';
  for (const b of buf) s += ((b >> 4) & 0xf).toString() + (b & 0xf).toString();
  return s.replace(/^0+/, '') || '0';
}

function strToBcd(str, len) {
  const padded = str.padStart(len * 2, '0');
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    buf[i] = (parseInt(padded[i * 2]) << 4) | parseInt(padded[i * 2 + 1]);
  }
  return buf;
}

// Decode a frame (already unwrapped from 0x7e and unescaped will be done here too).
function decode(rawInner) {
  const data = unescape(rawInner);
  if (data.length < 13) throw new Error('frame too short');
  const checksum = data[data.length - 1];
  const body = data.slice(0, data.length - 1);
  if (xor(body) !== checksum) throw new Error('bad checksum');

  const msgId = body.readUInt16BE(0);
  const attrs = body.readUInt16BE(2);
  const bodyLen = attrs & 0x3ff;
  const subpkg = !!(attrs & 0x2000);
  const versionFlag = !!(attrs & 0x4000); // 2019 variant if set

  let off = 4;
  let phone;
  // 2019 uses 10 BCD bytes; 2013 uses 6. If versionFlag, add 1-byte protocol version then 10-BCD.
  if (versionFlag) {
    off = 5; // skip protocol version byte at index 4
    phone = bcdToStr(body.slice(off, off + 10));
    off += 10;
  } else {
    phone = bcdToStr(body.slice(off, off + 6));
    off += 6;
  }
  const serial = body.readUInt16BE(off); off += 2;
  let totalPkts = 1, pktIndex = 1;
  if (subpkg) {
    totalPkts = body.readUInt16BE(off); off += 2;
    pktIndex  = body.readUInt16BE(off); off += 2;
  }
  const msgBody = body.slice(off, off + bodyLen);
  return { msgId, attrs, phone, serial, subpkg, versionFlag, totalPkts, pktIndex, body: msgBody, raw: data };
}

// Build & send: header + body, append XOR, escape, wrap with 0x7e.
function encode({ msgId, phone, serial, body = Buffer.alloc(0), version2019 = false }) {
  const bodyLen = body.length & 0x3ff;
  let header;
  if (version2019) {
    const attrs = bodyLen | 0x4000;
    header = Buffer.alloc(2 + 2 + 1 + 10 + 2);
    header.writeUInt16BE(msgId, 0);
    header.writeUInt16BE(attrs, 2);
    header[4] = 0x01; // protocol version
    strToBcd(phone, 10).copy(header, 5);
    header.writeUInt16BE(serial, 15);
  } else {
    const attrs = bodyLen;
    header = Buffer.alloc(2 + 2 + 6 + 2);
    header.writeUInt16BE(msgId, 0);
    header.writeUInt16BE(attrs, 2);
    strToBcd(phone, 6).copy(header, 4);
    header.writeUInt16BE(serial, 10);
  }
  const inner = Buffer.concat([header, body]);
  const cs = Buffer.from([xor(inner)]);
  const escaped = escape(Buffer.concat([inner, cs]));
  return Buffer.concat([Buffer.from([0x7e]), escaped, Buffer.from([0x7e])]);
}

module.exports = { unescape, escape, xor, extractFrames, decode, encode, bcdToStr, strToBcd };
