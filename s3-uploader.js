// Upload alarm media files to S3 and return their public URL.
// Uses AWS SDK v3. Credentials come from the EC2 instance IAM role by default
// (or env AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY for local dev).

const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { make } = require('./logger');
const log = make('S3');

const BUCKET      = process.env.S3_BUCKET      || 'starkenn-dms-media';
const REGION      = process.env.AWS_REGION     || 'ap-south-1';
const PUBLIC_BASE = process.env.S3_PUBLIC_BASE || `https://${BUCKET}.s3.${REGION}.amazonaws.com`;
const KEY_PREFIX  = process.env.S3_KEY_PREFIX  || 'dms';
const ENABLED     = process.env.S3_ENABLED !== 'false';

const client = ENABLED ? new S3Client({ region: REGION }) : null;
let uploaded = 0;
let failed = 0;

function contentTypeFor(fname) {
  const ext = (fname.split('.').pop() || '').toLowerCase();
  return ({
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    mp4: 'video/mp4', h264: 'video/mp4', h265: 'video/mp4', '265': 'video/mp4',
    wav: 'audio/wav', bin: 'application/octet-stream',
  })[ext] || 'application/octet-stream';
}

// Build S3 key: dms/<hmiId>/<YYYY-MM-DD>/<alarmNumber>/<filename>
function makeKey({ hmiId, alarmNumber, filename, ts = new Date() }) {
  const date = ts.toISOString().slice(0, 10);
  const safeName = path.basename(filename);
  const id = hmiId || 'unknown';
  const an = alarmNumber || 'no-alarm-number';
  return [KEY_PREFIX, id, date, an, safeName].join('/');
}

async function uploadFile({ localPath, hmiId, alarmNumber, filename }) {
  if (!ENABLED) { log.debug('S3 disabled, skip upload'); return null; }
  try {
    const body = fs.readFileSync(localPath);
    const key = makeKey({ hmiId, alarmNumber, filename: filename || path.basename(localPath) });
    await client.send(new PutObjectCommand({
      Bucket: BUCKET, Key: key, Body: body,
      ContentType: contentTypeFor(filename || localPath),
      CacheControl: 'public, max-age=31536000',
    }));
    uploaded++;
    const url = `${PUBLIC_BASE}/${key}`;
    log.info(`uploaded ${path.basename(localPath)} -> ${url}`);
    return url;
  } catch (e) {
    failed++;
    log.warn(`upload failed for ${localPath}: ${e.message}`);
    return null;
  }
}

function stats() { return { enabled: ENABLED, bucket: BUCKET, region: REGION, uploaded, failed }; }

module.exports = { uploadFile, stats };
