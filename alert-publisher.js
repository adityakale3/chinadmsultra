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

const pending = new Map();   // alarmNumber → entry

function classify(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'mp4' || ext === 'h264' || ext === 'h265' || ext === '265') return 'video';
  if (ext === 'jpg' || ext === 'jpeg' || ext === 'png') return 'image';
  return 'data';
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
  const entry = {
    ...p,
    media: { image: '', video: '', dashcam: '', data: '' },
    expectedFiles: p.expectedFiles || 3,
    receivedFiles: 0,
    fired: false,
    timer: setTimeout(() => fire(alarmNumber, 'timeout'), FIRE_TIMEOUT_MS),
  };
  pending.set(alarmNumber, entry);
  log.info(`queue alarmNumber=${alarmNumber} hmi=${p.hmiId} kind=${p.alarmKind} ev=0x${(p.eventTypeHex||0).toString(16)}`);
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
  if (!entry) {
    log.debug(`attachMedia: no pending alarm for ${alarmNumber} (orphan upload)`);
    return;
  }
  entry.receivedFiles++;
  const kind = classify(filename);
  if (url) {
    if (kind === 'video') { entry.media.video = url; entry.media.dashcam = url; }
    else if (kind === 'image') entry.media.image = url;
    else entry.media.data = url;
  }
  log.info(`alarmNumber=${alarmNumber} got ${kind} (${entry.receivedFiles}/${entry.expectedFiles})`);
  if (entry.receivedFiles >= entry.expectedFiles) fire(alarmNumber, 'complete');
}

function fire(alarmNumber, reason) {
  const e = pending.get(alarmNumber);
  if (!e || e.fired) return;
  e.fired = true;
  clearTimeout(e.timer);
  log.info(`fire alarmNumber=${alarmNumber} reason=${reason} files=${e.receivedFiles}/${e.expectedFiles}`);
  mqttPub.publishAlert({
    hmiId: e.hmiId,
    alarmKind: e.alarmKind,
    eventTypeHex: e.eventTypeHex,
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

module.exports = { queueAlarm, attachMedia, setExpectedFiles, stats };
