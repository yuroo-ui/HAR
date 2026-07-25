/**
 * PostgreSQL primary store for HAR capture.
 * Env: HAR_DATABASE_URL or HAR_PG_* vars.
 */
import pg from 'pg';

const { Pool } = pg;

let pool = null;

function getPool() {
  if (pool) return pool;
  // RDS requires SSL; local postgres usually does not.
  const host = process.env.HAR_PG_HOST || '127.0.0.1';
  const isRds = host.includes('.rds.amazonaws.com') || process.env.HAR_PG_SSL === '1';
  const ssl = isRds ? { rejectUnauthorized: false } : undefined;
  // Prefer discrete vars so we fully control SSL (connectionString sslmode can conflict).
  if (process.env.HAR_PG_HOST || process.env.HAR_PG_PASSWORD) {
    pool = new Pool({
      host,
      port: Number(process.env.HAR_PG_PORT || 5432),
      database: process.env.HAR_PG_DB || 'har_capture',
      user: process.env.HAR_PG_USER || 'har',
      password: process.env.HAR_PG_PASSWORD || '',
      max: 8,
      ssl,
    });
  } else if (process.env.HAR_DATABASE_URL) {
    pool = new Pool({ connectionString: process.env.HAR_DATABASE_URL, max: 8, ssl });
  } else {
    pool = new Pool({
      host: '127.0.0.1',
      port: 5432,
      database: 'har_capture',
      user: 'har',
      password: '',
      max: 8,
    });
  }
  pool.on('error', (err) => console.warn('[pg] idle client error', err.message));
  return pool;
}

export function pgEnabled() {
  return !!(process.env.HAR_DATABASE_URL || process.env.HAR_PG_PASSWORD || process.env.HAR_STORE_PRIMARY === 'postgres');
}

export async function initPg() {
  const p = getPool();
  await p.query('SELECT 1');
  return p;
}

export async function createSession(name) {
  const createdAt = Date.now();
  const sessionName = name || new Date(createdAt).toISOString().replace(/[:.]/g, '-');
  const r = await getPool().query(
    'INSERT INTO sessions (name, created_at) VALUES ($1, $2) RETURNING id',
    [sessionName, createdAt],
  );
  return Number(r.rows[0].id);
}

export async function closeSession(sessionId) {
  await getPool().query('UPDATE sessions SET closed_at = $1 WHERE id = $2', [Date.now(), sessionId]);
}

export async function listSessions() {
  const r = await getPool().query(
    `SELECT s.id, s.name, s.created_at AS "createdAt", s.closed_at AS "closedAt",
            (SELECT COUNT(*) FROM requests rq WHERE rq.session_id = s.id) AS count
     FROM sessions s ORDER BY s.created_at DESC`,
  );
  return r.rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    createdAt: Number(row.createdAt),
    closedAt: row.closedAt == null ? null : Number(row.closedAt),
    count: Number(row.count || 0),
  }));
}

export async function deleteSession(sessionId) {
  await getPool().query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

export async function renameSession(sessionId, name) {
  await getPool().query('UPDATE sessions SET name = $1 WHERE id = $2', [name, sessionId]);
}

export async function saveRequest(sessionId, req) {
  await getPool().query(
    `INSERT INTO requests (id, session_id, data, host, type, method, status, started_at)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8)
     ON CONFLICT (session_id, id) DO UPDATE SET
       data = EXCLUDED.data,
       host = EXCLUDED.host,
       type = EXCLUDED.type,
       method = EXCLUDED.method,
       status = EXCLUDED.status,
       started_at = EXCLUDED.started_at`,
    [
      req.id,
      sessionId,
      JSON.stringify(req),
      req.host || null,
      req.type || null,
      req.method || null,
      req.status ?? null,
      req.startedAt || Date.now(),
    ],
  );
}

export async function updateRequest(sessionId, id, patch) {
  const p = getPool();
  const cur = await p.query('SELECT data FROM requests WHERE session_id = $1 AND id = $2', [sessionId, id]);
  if (!cur.rows[0]) return false;
  const data = typeof cur.rows[0].data === 'string' ? JSON.parse(cur.rows[0].data) : cur.rows[0].data;
  Object.assign(data, patch);
  await p.query(
    `UPDATE requests SET data = $1::jsonb, host = $2, type = $3, method = $4, status = $5, started_at = $6
     WHERE session_id = $7 AND id = $8`,
    [
      JSON.stringify(data),
      data.host || null,
      data.type || null,
      data.method || null,
      data.status ?? null,
      data.startedAt || Date.now(),
      sessionId,
      id,
    ],
  );
  return true;
}

export async function appendWsMessage(sessionId, id, message) {
  const p = getPool();
  const cur = await p.query('SELECT data FROM requests WHERE session_id = $1 AND id = $2', [sessionId, id]);
  if (!cur.rows[0]) return false;
  const data = typeof cur.rows[0].data === 'string' ? JSON.parse(cur.rows[0].data) : cur.rows[0].data;
  data.wsMessages = data.wsMessages || [];
  data.wsMessages.push(message);
  if (data.wsMessages.length > 500) data.wsMessages = data.wsMessages.slice(-500);
  await p.query('UPDATE requests SET data = $1::jsonb WHERE session_id = $2 AND id = $3', [
    JSON.stringify(data),
    sessionId,
    id,
  ]);
  return true;
}

export async function loadRequests(sessionId, { limit = 500, offset = 0, q = '', host = '', method = '' } = {}) {
  const params = [sessionId];
  let sql = 'SELECT data FROM requests WHERE session_id = $1';
  if (host) {
    params.push(`%${host}%`);
    sql += ` AND host ILIKE $${params.length}`;
  }
  if (method) {
    params.push(method);
    sql += ` AND method = $${params.length}`;
  }
  if (q) {
    params.push(`%${q}%`);
    sql += ` AND (data::text ILIKE $${params.length} OR host ILIKE $${params.length} OR method ILIKE $${params.length})`;
  }
  params.push(limit);
  sql += ` ORDER BY started_at DESC LIMIT $${params.length}`;
  params.push(offset);
  sql += ` OFFSET $${params.length}`;
  const r = await getPool().query(sql, params);
  return r.rows.map((row) => (typeof row.data === 'string' ? JSON.parse(row.data) : row.data));
}

export async function countRequests(sessionId) {
  const r = await getPool().query('SELECT COUNT(*)::int AS c FROM requests WHERE session_id = $1', [sessionId]);
  return r.rows[0]?.c || 0;
}

export async function saveCaptcha(sessionId, det) {
  await getPool().query(
    `INSERT INTO captchas
     (id, session_id, type, sitekey, page_url, page_host, source_url, source, detected_at, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     ON CONFLICT (session_id, id) DO UPDATE SET
       type = EXCLUDED.type,
       sitekey = EXCLUDED.sitekey,
       page_url = EXCLUDED.page_url,
       page_host = EXCLUDED.page_host,
       source_url = EXCLUDED.source_url,
       source = EXCLUDED.source,
       detected_at = EXCLUDED.detected_at,
       data = EXCLUDED.data`,
    [
      det.id,
      sessionId,
      det.type,
      det.sitekey,
      det.pageUrl || null,
      det.pageHost || null,
      det.sourceUrl || null,
      det.source || null,
      det.detectedAt || Date.now(),
      JSON.stringify(det),
    ],
  );
}

export async function loadCaptchas(sessionId) {
  const r = await getPool().query(
    'SELECT data FROM captchas WHERE session_id = $1 ORDER BY detected_at DESC',
    [sessionId],
  );
  return r.rows.map((row) => (typeof row.data === 'string' ? JSON.parse(row.data) : row.data));
}

export async function clearRequests(sessionId) {
  await getPool().query('DELETE FROM requests WHERE session_id = $1', [sessionId]);
}

export async function setPref(key, value) {
  await getPool().query(
    `INSERT INTO prefs (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
}

export async function getPref(key, fallback) {
  const r = await getPool().query('SELECT value FROM prefs WHERE key = $1', [key]);
  if (!r.rows[0]) return fallback;
  return r.rows[0].value;
}

export async function getOrCreateActiveSession() {
  const p = getPool();
  const open = await p.query(
    'SELECT id FROM sessions WHERE closed_at IS NULL ORDER BY created_at DESC LIMIT 1',
  );
  if (open.rows[0]) return Number(open.rows[0].id);
  return createSession();
}

export async function saveCookie(sessionId, cookie) {
  const r = await getPool().query(
    `INSERT INTO cookies
     (session_id, host, name, value, domain, http_only, secure, path, source, url, raw, ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [
      sessionId,
      cookie.host || null,
      cookie.name || null,
      cookie.value || null,
      cookie.domain || null,
      !!cookie.httpOnly,
      !!cookie.secure,
      cookie.path || null,
      cookie.source || null,
      cookie.url || null,
      cookie.raw || null,
      cookie.ts || Date.now(),
    ],
  );
  return Number(r.rows[0].id);
}

export async function saveCookiesBulk(sessionId, cookies) {
  if (!cookies?.length) return 0;
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    for (const cookie of cookies) {
      await client.query(
        `INSERT INTO cookies
         (session_id, host, name, value, domain, http_only, secure, path, source, url, raw, ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          sessionId,
          cookie.host || null,
          cookie.name || null,
          cookie.value || null,
          cookie.domain || null,
          !!cookie.httpOnly,
          !!cookie.secure,
          cookie.path || null,
          cookie.source || null,
          cookie.url || null,
          cookie.raw || null,
          cookie.ts || Date.now(),
        ],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return cookies.length;
}

export async function loadCookies(sessionId, { limit = 500, host = '', name = '' } = {}) {
  const params = [sessionId];
  let sql = 'SELECT * FROM cookies WHERE session_id = $1';
  if (host) {
    params.push(`%${host}%`);
    sql += ` AND host ILIKE $${params.length}`;
  }
  if (name) {
    params.push(`%${name}%`);
    sql += ` AND name ILIKE $${params.length}`;
  }
  params.push(limit);
  sql += ` ORDER BY ts DESC LIMIT $${params.length}`;
  const r = await getPool().query(sql, params);
  return r.rows.map((row) => ({
    id: Number(row.id),
    sessionId: Number(row.session_id),
    host: row.host,
    name: row.name,
    value: row.value,
    domain: row.domain,
    httpOnly: !!row.http_only,
    secure: !!row.secure,
    path: row.path,
    source: row.source,
    url: row.url,
    raw: row.raw,
    ts: Number(row.ts),
  }));
}

export async function clearCookies(sessionId) {
  await getPool().query('DELETE FROM cookies WHERE session_id = $1', [sessionId]);
}

export async function exportCookieJar(sessionId) {
  const rows = await loadCookies(sessionId, { limit: 5000 });
  const map = new Map();
  for (const r of rows) {
    const key = `${r.host || ''}::${r.name || ''}`;
    if (!map.has(key)) map.set(key, r);
  }
  return Array.from(map.values()).sort(
    (a, b) => (a.host || '').localeCompare(b.host || '') || (a.name || '').localeCompare(b.name || ''),
  );
}
