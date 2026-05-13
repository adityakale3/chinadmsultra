// 0x0200 location report. Body: alarm(DWORD) status(DWORD) lat lon altitude(WORD)
// speed(WORD, 1/10 km/h) direction(WORD) time(BCD6 YYMMDDhhmmss) + TLV extras.

// 32 bits, indexed 0..31. JT/T 808-2019 + common ULV vendor extensions.
// Some bits are vendor-repurposed (e.g. bit 15 / bit 28 carry alcohol on Starkenn).
const ALARM_BITS = [
  'sos',                       // 0
  'overspeed',                 // 1
  'fatigue_driving',           // 2
  'danger_warning',            // 3
  'gnss_module_fault',         // 4
  'gnss_antenna_disconnect',   // 5
  'gnss_antenna_short',        // 6
  'lvss_undervoltage',         // 7
  'lvss_power_off',            // 8
  'lcd_fault',                 // 9
  'tts_fault',                 // 10
  'camera_fault',              // 11
  'road_card_fault',           // 12
  'overspeed_warning',         // 13
  'fatigue_warning',           // 14
  'alcohol_drunk_driving',     // 15  ← vendor-extension: alcohol >= drunk threshold
  'timeout_parking',           // 16
  'zone_in_out',               // 17
  'route_in_out',              // 18
  'route_segment_time',        // 19
  'route_deviation',           // 20
  'vss_fault',                 // 21
  'oil_abnormal',              // 22
  'vehicle_stolen',            // 23
  'illegal_ignition',          // 24
  'illegal_displacement',      // 25
  'collision_alarm',           // 26
  'rollover_alarm',            // 27
  'alcohol_warning',           // 28  ← vendor-extension: alcohol >= warning threshold
  'collision_warning',         // 29
  'rollover_warning',          // 30
  'illegal_door_open',         // 31
];

// Bits that mean "alcohol detector tripped" so callers can route to the alcohol pipeline.
const ALCOHOL_BITS = [15, 28];

function decodeBcdTime(buf) {
  // YYMMDDhhmmss -> "20YY-MM-DD HH:MM:SS"
  const s = [...buf].map(b => ((b >> 4) & 0xf).toString() + (b & 0xf).toString()).join('');
  if (s.length < 12) return s;
  return `20${s.slice(0,2)}-${s.slice(2,4)}-${s.slice(4,6)} ${s.slice(6,8)}:${s.slice(8,10)}:${s.slice(10,12)}`;
}

function decodeAlarmFlags(n) {
  const out = [];
  for (let i = 0; i < 32; i++) if (n & (1 << i)) out.push(ALARM_BITS[i] || `bit${i}`);
  return out;
}

const ADAS_EVENT = {1:'forward_collision',2:'lane_deviation',3:'close_distance',4:'pedestrian_collision',5:'frequent_lane_change',6:'road_sign_overrun',7:'obstacle',8:'driving_assist_state',16:'road_sign_recog',17:'active_capture'};
const DSM_EVENT  = {1:'fatigue',2:'phone_call',3:'smoking',4:'distracted',5:'driver_abnormal',6:'no_seatbelt',16:'auto_capture',17:'driver_change'};
const BSD_EVENT  = {1:'rear_approach',2:'left_approach',3:'right_approach'};

function parseAlarmId(buf) {
  // Table 3.5.12: termId(7B ascii) + time(BCD6) + serial(1B) + attCount(1B) + reserved(1B)
  return {
    termId: buf.slice(0, 7).toString('ascii').replace(/\0+$/, ''),
    time: decodeBcdTime(buf.slice(7, 13)),
    serial: buf[13],
    attachmentCount: buf[14],
  };
}

function parseAdasDsmBsd(kind, v) {
  if (v.length < 32) return { kind, raw: v.toString('hex') };
  const o = {
    kind,
    alarmId: v.readUInt32BE(0),
    flagState: v[4],
    alarmLevel: v[5],
    eventType: v[6],
    eventName: (kind === 'ADAS' ? ADAS_EVENT : kind === 'DSM' ? DSM_EVENT : BSD_EVENT)[v[6]] || `evt_${v[6]}`,
  };
  // last 16 bytes of the additional item are the alarm identification number
  o.alarmIdentification = parseAlarmId(v.slice(v.length - 16));
  return o;
}

function parseExtras(buf) {
  const items = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const id = buf[i]; const len = buf[i + 1]; i += 2;
    if (i + len > buf.length) break;
    const v = buf.slice(i, i + len);
    i += len;
    let parsed = { id: '0x' + id.toString(16).padStart(2,'0'), len };
    switch (id) {
      case 0x01: parsed.mileage_km = v.readUInt32BE(0) / 10; break;
      case 0x02: parsed.fuel_l = v.readUInt16BE(0) / 10; break;
      case 0x03: parsed.speed_record = v.readUInt16BE(0) / 10; break;
      case 0x04: parsed.alarm_event_id = v.readUInt16BE(0); break;
      case 0x14: parsed.video_alarm = v.readUInt32BE(0); break;
      case 0x64: Object.assign(parsed, parseAdasDsmBsd('ADAS', v)); break;
      case 0x65: Object.assign(parsed, parseAdasDsmBsd('DSM',  v)); break;
      case 0x66: Object.assign(parsed, parseAdasDsmBsd('BSD',  v)); break;
      default:   parsed.hex = v.toString('hex');
    }
    items.push(parsed);
  }
  return items;
}

function parseLocation(body) {
  if (body.length < 28) return { error: 'short' };
  const alarmFlag = body.readUInt32BE(0);
  const status    = body.readUInt32BE(4);
  const lat       = body.readUInt32BE(8)  / 1e6;
  const lon       = body.readUInt32BE(12) / 1e6;
  const alt       = body.readUInt16BE(16);
  const speed     = body.readUInt16BE(18) / 10;
  const direction = body.readUInt16BE(20);
  const time      = decodeBcdTime(body.slice(22, 28));
  const extras    = parseExtras(body.slice(28));
  return {
    alarmFlag: '0x' + alarmFlag.toString(16),
    alarms: decodeAlarmFlags(alarmFlag),
    status: '0x' + status.toString(16),
    lat, lon, altitude: alt, speed_kmh: speed, direction, time,
    extras,
  };
}

// 0x0704 bulk location: itemCount(WORD) type(BYTE) [ length(WORD) locationBody ]*
function parseBulkLocation(body) {
  if (body.length < 3) return { error: 'short' };
  const count = body.readUInt16BE(0);
  const dataType = body[2]; // 0 = normal batch, 1 = blind-area supplement
  const items = [];
  let p = 3;
  while (p + 2 <= body.length && items.length < count) {
    const len = body.readUInt16BE(p); p += 2;
    if (p + len > body.length) break;
    items.push(parseLocation(body.slice(p, p + len)));
    p += len;
  }
  return { count, dataType, items };
}

function alcoholFromAlarmFlag(n) {
  return ALCOHOL_BITS.filter(b => n & (1 << b)).map(b => ALARM_BITS[b]);
}

module.exports = { parseLocation, parseBulkLocation, parseAlarmId, alcoholFromAlarmFlag, ALARM_BITS, ALCOHOL_BITS };
