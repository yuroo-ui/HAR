/**
 * Operator helpers: rate limit, telegram alerts, retention, curl+cookies, zip export.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Rate limit ──────────────────────────────────────────────
const hits = new Map(); // ip -> { count, reset }
export function rateLimit(ip, { limit = 120, windowMs = 60_000 } = {}) {
  const now = Date.now();
  const key = ip || 'unknown';
  let row = hits.get(key);
  if (!row || now > row.reset) {
    row = { count: 0, reset: now + windowMs };
    hits.set(key, row);
  }
  row.count += 1;
  if (row.count > limit) {
    return { ok: false, retryAfterMs: Math.max(0, row.reset - now), count: row.count };
  }
  return { ok: true, remaining: limit - row.count, count: row.count };
}

// ── Telegram alerts ─────────────────────────────────────────
const TG_TOKEN = process.env.HAR_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.HAR_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '';
const alertState = {
  lastSent: new Map(), // key -> ts
  lastExtConnected: true,
  lastDbOk: true,
  lastRedisOk: true,
};

export function telegramConfigured() {
  return !!(TG_TOKEN && TG_CHAT);
}

export async function sendTelegram(text, { key = '', cooldownMs = 5 * 60_000 } = {}) {
  if (!telegramConfigured()) return { ok: false, reason: 'not-configured' };
  if (key) {
    const last = alertState.lastSent.get(key) || 0;
    if (Date.now() - last < cooldownMs) return { ok: false, reason: 'cooldown' };
  }
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT,
        text: String(text).slice(0, 3500),
        disable_web_page_preview: true,
      }),
    });
    if (key) alertState.lastSent.set(key, Date.now());
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

export async function evaluateHealthAlerts(health) {
  // health: { extensionConnected, dbOk, redisOk, lastExtEventAt, now }
  const now = health.now || Date.now();
  if (alertState.lastExtConnected && !health.extensionConnected) {
    await sendTelegram('HAR ALERT: extension disconnected from capture.eemaill.codes', { key: 'ext-down' });
  }
  if (!alertState.lastExtConnected && health.extensionConnected) {
    await sendTelegram('HAR OK: extension reconnected', { key: 'ext-up', cooldownMs: 60_000 });
  }
  alertState.lastExtConnected = !!health.extensionConnected;

  if (health.dbOk === false && alertState.lastDbOk) {
    await sendTelegram('HAR ALERT: database unreachable (RDS/Postgres)', { key: 'db-down' });
  }
  if (health.dbOk === true && !alertState.lastDbOk) {
    await sendTelegram('HAR OK: database back', { key: 'db-up', cooldownMs: 60_000 });
  }
  if (health.dbOk != null) alertState.lastDbOk = !!health.dbOk;

  if (health.redisOk === false && alertState.lastRedisOk) {
    await sendTelegram('HAR ALERT: redis down', { key: 'redis-down' });
  }
  if (health.redisOk === true && !alertState.lastRedisOk) {
    await sendTelegram('HAR OK: redis back', { key: 'redis-up', cooldownMs: 60_000 });
  }
  if (health.redisOk != null) alertState.lastRedisOk = !!health.redisOk;

  const quietMs = Number(process.env.HAR_ALERT_QUIET_MS || 15 * 60_000);
  if (health.extensionConnected && health.lastExtEventAt && now - health.lastExtEventAt > quietMs) {
    await sendTelegram(
      `HAR ALERT: extension connected but no capture events for ${Math.round((now - health.lastExtEventAt) / 60000)}m`,
      { key: 'quiet-capture', cooldownMs: quietMs },
    );
  }
}

// ── curl with cookies ───────────────────────────────────────
export function buildCurlWithCookies(req, cookieHeader = '') {
  const method = (req.method || 'GET').toUpperCase();
  const url = req.url || '';
  const headers = Array.isArray(req.requestHeaders) ? req.requestHeaders : [];
  const parts = [`curl -X ${method} '${url.replace(/'/g, `'\\''`)}'`];
  const skip = new Set(['content-length', 'host']);
  for (const h of headers) {
    const name = String(h.name || '');
    if (!name || skip.has(name.toLowerCase())) continue;
    if (name.toLowerCase() === 'cookie' && cookieHeader) continue;
    parts.push(`-H '${name}: ${String(h.value || '').replace(/'/g, `'\\''`)}'`);
  }
  if (cookieHeader) parts.push(`-H 'Cookie: ${cookieHeader.replace(/'/g, `'\\''`)}'`);
  if (req.requestBody) {
    parts.push(`--data-raw '${String(req.requestBody).replace(/'/g, `'\\''`)}'`);
  }
  return parts.join(' \\\n  ');
}

export function cookieHeaderForHost(jar, host) {
  if (!host) return (jar || []).map((c) => `${c.name}=${c.value}`).join('; ');
  const matched = (jar || []).filter((c) => {
    const d = (c.domain || c.host || '').replace(/^\./, '');
    const h = host.replace(/^\./, '');
    return h === d || h.endsWith('.' + d) || (c.host || '').includes(host);
  });
  // latest already collapsed by exportCookieJar
  return matched.map((c) => `${c.name}=${c.value}`).join('; ');
}

// ── ZIP export via system zip ───────────────────────────────
export function buildSessionZipBuffer({ sessionId, har, cookiesExport, summary }) {
  const dir = mkdtempSync(join(tmpdir(), 'har-export-'));
  try {
    writeFileSync(join(dir, `session-${sessionId}.har`), JSON.stringify(har, null, 2));
    writeFileSync(join(dir, 'cookies.json'), JSON.stringify(cookiesExport, null, 2));
    if (cookiesExport?.netscape) writeFileSync(join(dir, 'cookies.txt'), cookiesExport.netscape);
    if (cookiesExport?.cookieHeader) writeFileSync(join(dir, 'cookie-header.txt'), cookiesExport.cookieHeader);
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
    const zipPath = join(dir, `session-${sessionId}.zip`);
    const r = spawnSync('zip', ['-qj', zipPath, join(dir, `session-${sessionId}.har`), join(dir, 'cookies.json'), join(dir, 'cookies.txt'), join(dir, 'cookie-header.txt'), join(dir, 'summary.json')], { encoding: 'utf8' });
    if (r.status !== 0 || !existsSync(zipPath)) {
      throw new Error(r.stderr || 'zip failed');
    }
    return readFileSync(zipPath);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// ── Retention ───────────────────────────────────────────────
export async function runRetention({ listSessions, deleteSession, maxAgeDays }) {
  const days = Number(maxAgeDays || process.env.HAR_RETENTION_DAYS || 14);
  if (!days || days <= 0) return { deleted: 0, days };
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const sessions = await listSessions();
  let deleted = 0;
  for (const s of sessions || []) {
    const created = Number(s.createdAt || 0);
    const closed = s.closedAt == null ? null : Number(s.closedAt);
    // delete closed old sessions, or very old open sessions
    const stamp = closed || created;
    if (stamp && stamp < cutoff) {
      try {
        await deleteSession(s.id);
        deleted += 1;
      } catch (e) {
        console.warn('[retention] delete failed', s.id, e.message);
      }
    }
  }
  return { deleted, days, cutoff };
}
