const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const express = require('express');

const router = express.Router();

const MAX_SCHEMA_VERSION = Number(process.env.SYNC_MAX_SCHEMA_VERSION) || 1;
const MAX_VERSIONS = Math.max(1, Number(process.env.SYNC_MAX_VERSIONS) || 10);
const STORAGE_DIR = path.resolve(process.env.SYNC_STORAGE_DIR || path.join(process.cwd(), 'storage', 'backups'));
const SYNC_JWT_SECRET = process.env.SYNC_JWT_SECRET || '';
const REQUIRE_VERIFIED_IDENTITY = process.env.SYNC_REQUIRE_VERIFIED_IDENTITY !== 'false';

function base64UrlDecode(value) {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function verifiedJwtSubject(token) {
  if (!SYNC_JWT_SECRET || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header;
  let payload;
  try {
    header = JSON.parse(base64UrlDecode(parts[0]).toString('utf8'));
    payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
  } catch (_error) {
    return null;
  }
  if (header.alg !== 'HS256' || header.typ !== 'JWT' || typeof payload.sub !== 'string') return null;
  const expected = crypto.createHmac('sha256', SYNC_JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest();
  const provided = base64UrlDecode(parts[2]);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;
  if (payload.exp !== undefined && (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000))) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(payload.sub)) return null;
  return payload.sub;
}
function userIdFromRequest(req, res, next) {
  const authorization = req.get('Authorization') || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const verifiedUserId = verifiedJwtSubject(bearer);
  if (verifiedUserId) {
    req.plyndiUserId = verifiedUserId;
    req.plyndiIdentityVerified = true;
    return next();
  }
  if (REQUIRE_VERIFIED_IDENTITY) {
    return res.status(503).json({ error: 'Verified user identity is required for cloud sync. Configure SYNC_JWT_SECRET and send a valid bearer token.' });
  }
  const userId = req.get('X-Plyndi-User-ID');
  if (!userId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(userId)) {
    return res.status(400).json({ error: 'A valid X-Plyndi-User-ID header is required in development fallback mode.' });
  }
  req.plyndiUserId = userId;
  req.plyndiIdentityVerified = false;
  next();
}

function validateEnvelope(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Backup payload must be a JSON object.';
  }
  if (body.app !== 'Plyndi') return 'Backup payload app must be Plyndi.';
  if (!Number.isInteger(body.schemaVersion) || body.schemaVersion < 1 || body.schemaVersion > MAX_SCHEMA_VERSION) {
    return `Unsupported backup schema version. Supported maximum: ${MAX_SCHEMA_VERSION}.`;
  }
  if (typeof body.deviceId !== 'string' || body.deviceId.length < 1 || body.deviceId.length > 256) {
    return 'Backup payload deviceId is required.';
  }
  if (!body.state || typeof body.state !== 'object' || Array.isArray(body.state)) {
    return 'Backup payload state is required.';
  }
  return null;
}

function backupFileName(userId, backupId) {
  return `backup-${userId}-${backupId}.json`;
}

async function ensureStorage() {
  await fs.mkdir(STORAGE_DIR, { recursive: true, mode: 0o700 });
}

async function readUserBackups(userId) {
  await ensureStorage();
  const prefix = `backup-${userId}-`;
  const names = (await fs.readdir(STORAGE_DIR)).filter((name) => name.startsWith(prefix) && name.endsWith('.json'));
  const backups = [];
  for (const name of names) {
    try {
      const record = JSON.parse(await fs.readFile(path.join(STORAGE_DIR, name), 'utf8'));
      if (record.userId === userId && record.envelope) backups.push(record);
    } catch (error) {
      console.error(`[sync] skipping unreadable backup ${name}:`, error.message);
    }
  }
  return backups.sort((a, b) => String(b.storedAt).localeCompare(String(a.storedAt)));
}

async function pruneUserBackups(userId) {
  const backups = await readUserBackups(userId);
  for (const record of backups.slice(MAX_VERSIONS)) {
    await fs.rm(path.join(STORAGE_DIR, backupFileName(userId, record.backupId)), { force: true });
  }
}

router.post('/backups', userIdFromRequest, async (req, res, next) => {
  try {
    const validationError = validateEnvelope(req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    const backupId = crypto.randomUUID();
    const storedAt = new Date().toISOString();
    const record = {
      backupId,
      userId: req.plyndiUserId,
      storedAt,
      envelope: req.body
    };

    await ensureStorage();
    const finalPath = path.join(STORAGE_DIR, backupFileName(req.plyndiUserId, backupId));
    const temporaryPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporaryPath, finalPath);
    await pruneUserBackups(req.plyndiUserId);

    res.set('Cache-Control', 'no-store');
    return res.status(201).json({
      backupId,
      schemaVersion: req.body.schemaVersion,
      storedAt,
      retainedVersions: Math.min(MAX_VERSIONS, (await readUserBackups(req.plyndiUserId)).length)
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/backups/latest', userIdFromRequest, async (req, res, next) => {
  try {
    const latest = (await readUserBackups(req.plyndiUserId))[0];
    if (!latest) return res.status(404).json({ error: 'No Plyndi backup found for this user.' });
    res.set('Cache-Control', 'no-store');
    return res.status(200).json(latest.envelope);
  } catch (error) {
    return next(error);
  }
});

router.get('/backups', userIdFromRequest, async (req, res, next) => {
  try {
    const backups = await readUserBackups(req.plyndiUserId);
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({
      backups: backups.map(({ backupId, storedAt, envelope }) => ({
        backupId,
        storedAt,
        schemaVersion: envelope.schemaVersion,
        deviceId: envelope.deviceId
      }))
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
