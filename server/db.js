import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.HAR_DATA_DIR || join(__dirname, 'data');
mkdirSync(DATA_DIR, { recursive: true });

let db = null;

export function initDb() {
  if (db) return db;
  db = new Database(join(DATA_DIR, 'capture.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      closedAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT NOT NULL,
      sessionId INTEGER NOT NULL,
      data TEXT NOT NULL,
      host TEXT,
      type TEXT,
      method TEXT,
      status INTEGER,
      startedAt INTEGER,
      PRIMARY KEY (sessionId, id),
      FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(sessionId, startedAt);
    CREATE TABLE IF NOT EXISTS captchas (
      id TEXT NOT NULL,
      sessionId INTEGER NOT NULL,
      type TEXT NOT NULL,
      sitekey TEXT NOT NULL,
      pageUrl TEXT,
      pageHost TEXT,
      sourceUrl TEXT,
      source TEXT,
      detectedAt INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (sessionId, id),
      FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_captchas_session ON captchas(sessionId, detectedAt);
    CREATE TABLE IF NOT EXISTS prefs (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

export function createSession(name) {
  const d = initDb();
  const createdAt = Date.now();
  const sessionName = name || new Date(createdAt).toISOString().replace(/[:.]/g, '-');
  const info = d.prepare('INSERT INTO sessions (name, createdAt) VALUES (?, ?)').run(sessionName, createdAt);
  return Number(info.lastInsertRowid);
}

export function closeSession(sessionId) {
  initDb().prepare('UPDATE sessions SET closedAt = ? WHERE id = ?').run(Date.now(), sessionId);
}

export function listSessions() {
  return initDb()
    .prepare(
      `SELECT s.id, s.name, s.createdAt, s.closedAt,
              (SELECT COUNT(*) FROM requests r WHERE r.sessionId = s.id) AS count
       FROM sessions s ORDER BY s.createdAt DESC`,
    )
    .all();
}

export function deleteSession(sessionId) {
  const d = initDb();
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM requests WHERE sessionId = ?').run(sessionId);
    d.prepare('DELETE FROM captchas WHERE sessionId = ?').run(sessionId);
    d.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  });
  tx();
}

export function renameSession(sessionId, name) {
  initDb().prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, sessionId);
}

export function saveRequest(sessionId, req) {
  initDb()
    .prepare(
      `INSERT OR REPLACE INTO requests (id, sessionId, data, host, type, method, status, startedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      req.id,
      sessionId,
      JSON.stringify(req),
      req.host || null,
      req.type || null,
      req.method || null,
      req.status ?? null,
      req.startedAt || Date.now(),
    );
}

export function updateRequest(sessionId, id, patch) {
  const d = initDb();
  const row = d.prepare('SELECT data FROM requests WHERE sessionId = ? AND id = ?').get(sessionId, id);
  if (!row) return false;
  const cur = JSON.parse(row.data);
  Object.assign(cur, patch);
  d.prepare(
    `UPDATE requests SET data = ?, host = ?, type = ?, method = ?, status = ?, startedAt = ?
     WHERE sessionId = ? AND id = ?`,
  ).run(
    JSON.stringify(cur),
    cur.host || null,
    cur.type || null,
    cur.method || null,
    cur.status ?? null,
    cur.startedAt || Date.now(),
    sessionId,
    id,
  );
  return true;
}

export function appendWsMessage(sessionId, id, message) {
  const d = initDb();
  const row = d.prepare('SELECT data FROM requests WHERE sessionId = ? AND id = ?').get(sessionId, id);
  if (!row) return false;
  const cur = JSON.parse(row.data);
  cur.wsMessages = cur.wsMessages || [];
  cur.wsMessages.push(message);
  if (cur.wsMessages.length > 500) cur.wsMessages = cur.wsMessages.slice(-500);
  d.prepare('UPDATE requests SET data = ? WHERE sessionId = ? AND id = ?').run(
    JSON.stringify(cur),
    sessionId,
    id,
  );
  return true;
}

export function loadRequests(sessionId, { limit = 500, offset = 0, q = '', host = '', method = '' } = {}) {
  const d = initDb();
  let sql = 'SELECT data FROM requests WHERE sessionId = ?';
  const params = [sessionId];
  if (host) {
    sql += ' AND host LIKE ?';
    params.push(`%${host}%`);
  }
  if (method) {
    sql += ' AND method = ?';
    params.push(method);
  }
  if (q) {
    sql += ' AND (data LIKE ? OR host LIKE ? OR method LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  sql += ' ORDER BY startedAt DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return d.prepare(sql).all(...params).map((r) => JSON.parse(r.data));
}

export function countRequests(sessionId) {
  const row = initDb().prepare('SELECT COUNT(*) AS c FROM requests WHERE sessionId = ?').get(sessionId);
  return row?.c || 0;
}

export function saveCaptcha(sessionId, det) {
  initDb()
    .prepare(
      `INSERT OR REPLACE INTO captchas
       (id, sessionId, type, sitekey, pageUrl, pageHost, sourceUrl, source, detectedAt, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
    );
}

export function loadCaptchas(sessionId) {
  return initDb()
    .prepare('SELECT data FROM captchas WHERE sessionId = ? ORDER BY detectedAt DESC')
    .all(sessionId)
    .map((r) => JSON.parse(r.data));
}

export function clearRequests(sessionId) {
  initDb().prepare('DELETE FROM requests WHERE sessionId = ?').run(sessionId);
}

export function setPref(key, value) {
  initDb().prepare('INSERT OR REPLACE INTO prefs (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

export function getPref(key, fallback) {
  const row = initDb().prepare('SELECT value FROM prefs WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export function getOrCreateActiveSession() {
  const d = initDb();
  const open = d.prepare('SELECT id FROM sessions WHERE closedAt IS NULL ORDER BY createdAt DESC LIMIT 1').get();
  if (open) return open.id;
  return createSession();
}
