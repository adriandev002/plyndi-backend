const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function tokenFor(subject, secret, expiresInSeconds = 300) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ sub: subject, exp: Math.floor(Date.now() / 1000) + expiresInSeconds });
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Backend exited before health check');
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch (_error) {
      // Keep polling while the child starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Backend health check timed out');
}

test('sync backup routes validate ownership and retain version metadata', async (t) => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'plyndi-sync-'));
  const port = 38765 + Math.floor(Math.random() * 500);
  const secret = 'test-sync-secret';
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), CLIENT_SHARED_KEY: 'test-client-key', SYNC_STORAGE_DIR: storage, SYNC_JWT_SECRET: secret, SYNC_REQUIRE_VERIFIED_IDENTITY: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await fs.rm(storage, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child);
  const headers = { 'content-type': 'application/json', 'X-Plyndi-Client-Key': 'test-client-key', authorization: `Bearer ${tokenFor('user-a', secret)}` };
  const envelope = { app: 'Plyndi', schemaVersion: 1, deviceId: 'android-test', state: { accounts: [] } };
  const created = await fetch(`${baseUrl}/v1/sync/backups`, { method: 'POST', headers, body: JSON.stringify(envelope) });
  assert.equal(created.status, 201);
  const latest = await fetch(`${baseUrl}/v1/sync/backups/latest`, { headers });
  assert.equal(latest.status, 200);
  assert.equal((await latest.json()).app, 'Plyndi');
  const listed = await fetch(`${baseUrl}/v1/sync/backups`, { headers });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).backups.length, 1);
  const otherHeaders = { ...headers, authorization: `Bearer ${tokenFor('user-b', secret)}` };
  const otherLatest = await fetch(`${baseUrl}/v1/sync/backups/latest`, { headers: otherHeaders });
  assert.equal(otherLatest.status, 404);
});
