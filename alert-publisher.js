// Coalesces alarm-fired + attachment-uploaded events into one MQTT publish.
//
// Lifecycle:
//   1. handlers.js calls queueAlarm({ alarmNumber, hmiId, alarmKind, eventTypeHex, ... })
//      → we register a pending alarm with a fire deadline (default 90 s).
//   2. attachment-server.js calls attachMedia({ alarmNumber, hmiId, localPath, filename })
//      → we upload the file to S3 and stash the URL on the pending alarm.
//   3. When all expected files have arrived (we infer 3 from the 0x1210 file list,
//      or after the deadline if not all arrive), we publish ONCE to MQTT with media
//      URLs filled in, then remove the entry.

const path = require('path');
const mqttPub = require('./mqtt-publisher');
const s3 = require('./s3-uploader');
const { make } = require('./logger');
const log = make('ALERT');

const FIRE_TIMEOUT_MS = Number(process.env.ALERT_FIRE_TIMEOUT_MS || 90_000);
const RETENTION_MS    = Number(process.env.ALERT_RETENTION_MS    || 5 * 60 * 1000);

// Single source of truth for alert categorisation. Keyed by the 4-digit hex
// alarm code that the device puts in the file-name AND that we can synthesize
// from (channel byte, event-type byte). Values match what the m3 backend stores
// in the QuestDB `event` / `subevent` columns and the `data.alert_type` /
// `data.severity` JSON fields.
const SUBEVENT_MAP = {
  // DSM (cabin camera, channel 0x65)
  '6501': { event: 'DMS', subevent: 'DROW', alertType: 'DROWSINESS',           severity: 'HIGH'   },
  '6502': { event: 'DMS', subevent: 'PHO',  alertType: 'USING_PHONE',          severity: 'LOW'    },
  '6503': { event: 'DMS', subevent: 'SMOK', alertType: 'SMOKING',              severity: 'LOW'    },
  '6504': { event: 'DMS', subevent: 'DIST', alertType: 'DISTRACTED',           severity: 'MEDIUM' },
  '6505': { event: 'DMS', subevent: 'YAWN', alertType: 'YAWN',                 severity: 'LOW'    },
  '6506': { event: 'DMS', subevent: 'NDRV', alertType: 'NO_DRIVER',            severity: 'HIGH'   },
  '6507': { event: 'DMS', subevent: 'BELT', alertType: 'NO_SEATBELT',          severity: 'LOW'    },
  '6532': { event: 'DMS', subevent: 'ALCO', alertType: 'ALCOHOL',              severity: 'HIGH'   },
  // ADAS / Collision Avoidance (road camera, channel 0x64)
  '6401': { event: 'CAS', subevent: 'CAS',  alertType: 'FORWARD_COLLISION',    severity: 'HIGH'   },
  '6402': { event: 'CAS', subevent: 'LDW',  alertType: 'LANE_DEPARTURE',       severity: 'MEDIUM' },
  '6403': { event: 'CAS', subevent: 'HMW',  alertType: 'HEADWAY',              severity: 'MEDIUM' },
  '6404': { event: 'CAS', subevent: 'PCW',  alertType: 'PEDESTRIAN',           severity: 'HIGH'   },
  '6405': { event: 'CAS', subevent: 'FLC',  alertType: 'FREQUENT_LANE_CHANGE', severity: 'LOW'    },
  '6406': { event: 'CAS', subevent: 'RSO',  alertType: 'ROAD_SIGN_OVERRUN',    severity: 'MEDIUM' },
  '6407': { event: 'CAS', subevent: 'OBS',  alertType: 'OBSTACLE',             severity: 'HIGH'   },
  // BSD (side cameras, channel 0x66)
  '6601': { event: 'BSD', subevent: 'BSDR', alertType: 'BSD_REAR',             severity: 'MEDIUM' },
  '6602': { event: 'BSD', subevent: 'BSDL', alertType: 'BSD_LEFT',             severity: 'MEDIUM' },
  '6603': { event: 'BSD', subevent: 'BSDF', alertType: 'BSD_RIGHT',            severity: 'MEDIUM' },
};

const CHANNEL_BY_KIND = { DSM: 0x65, ADAS: 0x64, BSD: 0x66, ALCOHOL: 0x65 };

// Returns { alarmCode, event, subevent, alertType, severity } given the kind
// (DSM/ADAS/BSD/ALCOHOL) and the event-type byte from the JT/T 1078 alarm extra.
function classifyAlarm({ alarmKind, eventTypeHex }) {
  const ch = CHANNEL_BY_KIND[alarmKind];
  if (!ch || eventTypeHex == null) {
    return { alarmCode: null, event: alarmKind || 'UNKN', subevent: 'UNKN', alertType: 'UNKNOWN', severity: 'LOW' };
  }
  const code = ((ch << 8) | (eventTypeHex & 0xff)).toString(16).padStart(4, '0');
  const found = SUBEVENT_MAP[code];
  return { alarmCode: '0x' + code,
           ...(found || { event: alarmKind, subevent: 'UNKN', alertType: 'UNKNOWN', severity: 'LOW' }) };
}

const pending = new Map();   // alarmNumber → entry

function classify(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'mp4' || ext === 'h264' || ext === 'h265' || ext === '265') return 'video';
  if (ext === 'jpg' || ext === 'jpeg' || ext === 'png') return 'image';
  return 'data';
}

// JT/T 1078 alarm filename: <type>_<channel>_<alarmType>_<seq>_<alarmNumber>.<ext>
// Channel 00 = cabin (DSM) camera, 01 = road/front camera in dual-cam units.
function channelOf(filename) {
  const m = filename.match(/^\d+_(\d+)_/);
  return m ? Number(m[1]) : 0;
}

function queueAlarm(p) {
  const { alarmNumber } = p;
  if (!alarmNumber) {
    // No alarmNumber → fire immediately, no media coalescing possible.
    mqttPub.publishAlert(p);
    return;
  }
  if (pending.has(alarmNumber)) {
    log.debug(`queueAlarm ignored duplicate alarmNumber=${alarmNumber}`);
    return;
  }
  const cls = classifyAlarm({ alarmKind: p.alarmKind, eventTypeHex: p.eventTypeHex });
  const entry = {
    ...p,
    classification: cls,
    media: {
      image:   '',  // jpg/png cabin snapshot
      img_url: '',  // alias for image (some Lambdas read img_url)
      video:   '',  // mp4 cabin video
      media:   '',  // alias for video (matches non-China DMS payload)
      dashcam: '',  // alias for video
      inCabin: '',  // explicit cabin-camera URL (channel 0)
      outRoad: '',  // road/front camera URL (channel 1) — empty for single-cam units
      bin_url: '',  // .bin metadata blob
    },
    expectedFiles: p.expectedFiles || 3,
    receivedFiles: 0,
    fired: false,
    timer: setTimeout(() => fire(alarmNumber, 'timeout'), FIRE_TIMEOUT_MS),
  };
  pending.set(alarmNumber, entry);
  log.info(`queue alarmNumber=${alarmNumber} hmi=${p.hmiId} code=${cls.alarmCode} → ${cls.event}/${cls.subevent} ${cls.alertType} (${cls.severity})`);
}

// File 1210/1211 metadata arrived; we can use this to know the expected count.
function setExpectedFiles(alarmNumber, count) {
  const e = pending.get(alarmNumber);
  if (e) e.expectedFiles = count;
}

async function attachMedia({ alarmNumber, hmiId, localPath, filename }) {
  const entry = pending.get(alarmNumber);
  // Upload to S3 regardless — even orphaned uploads should be archived.
  const url = await s3.uploadFile({ localPath, hmiId: hmiId || entry?.hmiId, alarmNumber, filename });
  if (!url) log.warn(`S3 upload FAILED for ${filename} (alarmNumber=${alarmNumber}) — check creds, bucket, region`);
  const kind = classify(filename);
  const ch = channelOf(filename);

  // Build a delta of media fields this single file affects.
  function applyFileToMedia(media) {
    if (!url) return;
    if (kind === 'video') {
      media.video = url;
      media.media = url;
      media.dashcam = url;
      if (ch === 0) media.inCabin = url;
      if (ch === 1) media.outRoad = url;
    } else if (kind === 'image') {
      media.image = url;
      media.img_url = url;
    } else {
      media.bin_url = url;
    }
  }

  if (!entry) {
    // Alarm already fired (timeout) or never queued. Publish a follow-up
    // update so downstream can patch the existing alert row.
    if (url) {
      const media = {};
      applyFileToMedia(media);
      try {
        if (typeof mqttPub.publishAlertMediaUpdate === 'function') {
          mqttPub.publishAlertMediaUpdate({ alarmNumber, media });
        } else {
          mqttPub.publishAlert({ alarmNumber, alarmKind: 'MEDIA_LATE', media });
        }
        log.info(`alarmNumber=${alarmNumber} late ${kind} URL published as update`);
      } catch (e) { log.warn(`late media publish failed: ${e.message}`); }
    } else {
      log.debug(`attachMedia: no pending alarm for ${alarmNumber} and no S3 url (orphan)`);
    }
    return;
  }
  entry.receivedFiles++;
  applyFileToMedia(entry.media);
  log.info(`alarmNumber=${alarmNumber} got ${kind} ch=${ch} (${entry.receivedFiles}/${entry.expectedFiles}) ${url ? 'S3-ok' : 'S3-FAILED'}`);
  if (entry.receivedFiles >= entry.expectedFiles) fire(alarmNumber, 'complete');
}

function fire(alarmNumber, reason) {
  const e = pending.get(alarmNumber);
  if (!e || e.fired) return;
  e.fired = true;
  clearTimeout(e.timer);
  log.info(`fire alarmNumber=${alarmNumber} reason=${reason} files=${e.receivedFiles}/${e.expectedFiles} → ${e.classification.event}/${e.classification.subevent}`);
  mqttPub.publishAlert({
    hmiId: e.hmiId,
    alarmKind: e.alarmKind,
    eventTypeHex: e.eventTypeHex,
    // Categorisation fields — m3 backend reads these directly into QuestDB
    // event / subevent columns and into data.alert_type / data.severity.
    event:     e.classification.event,
    subevent:  e.classification.subevent,
    alertType: e.classification.alertType,
    severity:  e.classification.severity,
    alarmCode: e.classification.alarmCode,
    lat: e.lat, lon: e.lon,
    speed_kmh: e.speed_kmh, direction: e.direction,
    alarmNumber,
    media: e.media,
  });
  // keep the entry briefly so late uploads still match for logging
  setTimeout(() => pending.delete(alarmNumber), RETENTION_MS).unref();
}

function stats() {
  return { pending: pending.size, fireTimeoutMs: FIRE_TIMEOUT_MS };
}

module.exports = { queueAlarm, attachMedia, setExpectedFiles, stats, classifyAlarm, SUBEVENT_MAP };
