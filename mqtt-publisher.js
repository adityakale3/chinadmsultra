// Publishes JT808 location & alarm data to the Starkenn production MQTT broker.
// Downstream index2.js subscribes to '#', normalizes via JSON_2.0 schema, and fans
// out to SQS (location queue, alerts queue, notifications queue) + Socket.IO.
//
// We only need to publish here. No SQS / Redis / IoT Core involvement.

const mqtt = require('mqtt');
const { make } = require('./logger');
const log = make('MQTT');

const URL      = process.env.MQTT_URL      || 'mqtt://app.starkenn.com:1883';
const USERNAME = process.env.MQTT_USERNAME || 'starkenn';
const PASSWORD = process.env.MQTT_PASSWORD || 'semicolon';
const ENABLED  = process.env.MQTT_ENABLED !== 'false';   // set to 'false' to disable for testing
const QOS      = Number(process.env.MQTT_QOS || 0);

let client = null;
let connected = false;
const buffer = [];                  // queued while disconnected
const BUFFER_MAX = 500;
let droppedUnknown = 0;
let droppedInvalid = 0;
let published = 0;
let lastLogged = 0;

function start() {
  if (!ENABLED) { log.info('MQTT disabled via MQTT_ENABLED=false'); return; }
  log.info(`connecting to ${URL} as ${USERNAME}`);
  client = mqtt.connect(URL, {
    username: USERNAME,
    password: PASSWORD,
    clean: true,
    connectTimeout: 4000,
    reconnectPeriod: 1000,
    clientId: `ulv_dms_${Math.random().toString(16).slice(2, 10)}`,
  });
  client.on('connect', () => {
    connected = true;
    log.info(`connected. flushing ${buffer.length} buffered messages`);
    while (buffer.length) {
      const m = buffer.shift();
      doPublish(m.topic, m.payload);
    }
  });
  client.on('reconnect', () => log.info('reconnecting...'));
  client.on('close',     () => { connected = false; log.warn('connection closed'); });
  client.on('error',     (e) => log.warn(`error: ${e.message}`));
  client.on('offline',   () => { connected = false; log.warn('offline'); });

  setInterval(() => {
    if (published !== lastLogged) {
      log.info(`stats published=${published} buffered=${buffer.length} droppedUnknown=${droppedUnknown} droppedInvalid=${droppedInvalid}`);
      lastLogged = published;
    }
  }, 30_000).unref();
}

function doPublish(topic, payload) {
  if (!client || !connected) {
    if (buffer.length >= BUFFER_MAX) buffer.shift();    // drop oldest
    buffer.push({ topic, payload });
    return;
  }
  client.publish(topic, payload, { qos: QOS }, (err) => {
    if (err) log.warn(`publish ${topic} failed: ${err.message}`);
    else published++;
  });
}

// JT808 DSM eventType → Starkenn alert_type (consumed by normalizedJSON2 -> subevent map)
// Hex codes align with JT808 DSM alarm type bytes (6501–6507, 6532 in the SUBEVENT table)
const DSM_TO_ALERT = {
  0x01: { event: 'DMS', alert_type: 'DROWSINESS',  severity: 'HIGH'   }, // 6501
  0x02: { event: 'DMS', alert_type: 'USING_PHONE', severity: 'LOW'    }, // 6502
  0x03: { event: 'DMS', alert_type: 'SMOKING',     severity: 'LOW'    }, // 6503
  0x04: { event: 'DMS', alert_type: 'DISTRACTED',  severity: 'MEDIUM' }, // 6504
  0x05: { event: 'DMS', alert_type: 'YAWN',        severity: 'LOW'    }, // 6505
  0x06: { event: 'DMS', alert_type: 'NO_DRIVER',   severity: 'HIGH'   }, // 6506
  0x07: { event: 'DMS', alert_type: 'NO_SEATBELT', severity: 'LOW'    }, // 6507
  0x32: { event: 'DMS', alert_type: 'ALCOHOL',     severity: 'HIGH'   }, // 6532
};
// ADAS alarm types (6401–6404)
const ADAS_TO_ALERT = {
  0x01: { event: 'CAS', alert_type: 'FORWARD_COLLISION', severity: 'HIGH'   }, // 6401
  0x02: { event: 'CAS', alert_type: 'LANE_DEPARTURE',    severity: 'MEDIUM' }, // 6402
  0x03: { event: 'CAS', alert_type: 'HEADWAY',           severity: 'MEDIUM' }, // 6403
  0x04: { event: 'CAS', alert_type: 'PEDESTRIAN',        severity: 'HIGH'   }, // 6404
};
// BSD (Blind Spot Detection) alarm types (6601–6603)
const BSD_TO_ALERT = {
  0x01: { event: 'BSD', alert_type: 'BSD_REAR',  severity: 'MEDIUM' }, // 6601
  0x02: { event: 'BSD', alert_type: 'BSD_LEFT',  severity: 'MEDIUM' }, // 6602
  0x03: { event: 'BSD', alert_type: 'BSD_RIGHT', severity: 'MEDIUM' }, // 6603
};

function fmtLat(v) { return (v != null && !Number.isNaN(v)) ? Number(v).toFixed(5) : null; }
function fmtSpeed(v) { return Math.round(Number(v || 0)); }

function nowSec() { return Math.floor(Date.now() / 1000); }

function validCoords(lat, lng) {
  if (lat == null || lng == null) return false;
  if (lat === 0 && lng === 0) return false;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  return true;
}

// hmiId is the device's HMIID registered in datacollect.HMI (our `title` field).
function publishLocation({ hmiId, lat, lon, speed_kmh, direction, ignition = 1 }) {
  if (!ENABLED) return;
  if (!hmiId) { droppedUnknown++; return; }
  if (!validCoords(lat, lon)) { droppedInvalid++; return; }
  const ts = String(nowSec());
  const payload = {
    ver: 'JSON_2.0',
    dev_id: hmiId,
    dev_typ: 'DMS',
    time: ts,
    event: 'LOC',
    ignition: String(ignition),
    trip_id: '0',
    msg: '0',
    td: {
      lat: fmtLat(lat),
      lng: fmtLat(lon),
      spd: String(fmtSpeed(speed_kmh)),
      rssi: 0,
    },
    data: { spd: fmtSpeed(speed_kmh), dir: Number(direction || 0) },
  };
  doPublish(hmiId, JSON.stringify(payload));
}

// alarmKind: 'DSM' | 'ADAS' | 'BSD' | 'ALCOHOL'
// eventTypeHex: low byte of alarmType from the device
//   DSM:  0x01–0x07, 0x32 (ALCOHOL)
//   ADAS: 0x01–0x04
//   BSD:  0x01–0x03
function publishAlert({ hmiId, alarmKind, eventTypeHex, lat, lon, speed_kmh, direction, alarmNumber, media = {} }) {
  if (!ENABLED) return;
  if (!hmiId) { droppedUnknown++; return; }
  const ts = String(nowSec());
  let mapping;
  if (alarmKind === 'DSM' || alarmKind === 'ALCOHOL') {
    // ALCOHOL arrives with eventTypeHex=0x32 from the device; DSM_TO_ALERT covers it
    mapping = DSM_TO_ALERT[alarmKind === 'ALCOHOL' ? 0x32 : eventTypeHex];
  } else if (alarmKind === 'ADAS') {
    mapping = ADAS_TO_ALERT[eventTypeHex];
  } else if (alarmKind === 'BSD') {
    mapping = BSD_TO_ALERT[eventTypeHex];
  }
  if (!mapping) { droppedInvalid++; return; }

  const payload = {
    ver: 'JSON_2.0',
    dev_id: hmiId,
    dev_typ: 'DMS',
    time: ts,
    event: mapping.event,
    ignition: '1',
    trip_id: '0',
    msg: '0',
    td: {
      lat: validCoords(lat, lon) ? fmtLat(lat) : null,
      lng: validCoords(lat, lon) ? fmtLat(lon) : null,
      spd: String(fmtSpeed(speed_kmh)),
      rssi: 0,
    },
    data: {
      alert_type: mapping.alert_type,
      severity: mapping.severity,
      spd: fmtSpeed(speed_kmh),
      dir: Number(direction || 0),
      alarm_number: alarmNumber,
      dashcam: media.dashcam || '',
      media: media.video || '',
      img_url: media.image || '',
    },
  };
  doPublish(hmiId, JSON.stringify(payload));
}

function stats() {
  return { connected, buffered: buffer.length, published, droppedUnknown, droppedInvalid };
}

module.exports = { start, publishLocation, publishAlert, stats };
