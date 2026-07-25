/**
 * Unified store facade.
 * Primary: PostgreSQL when HAR_STORE_PRIMARY=postgres (default if DATABASE_URL set)
 * Fallback: SQLite (db.js)
 * Side: Redis live cache + optional AWS DynamoDB dual-write
 */
import * as sqlite from './db.js';
import * as pg from './pg-store.js';
import { awsPutCookie, awsPutRequest, awsEnabled } from './aws-store.js';
import {
  redisEnabled,
  redisPushRecentCookie,
  redisSetStatus,
  redisPing,
} from './redis-store.js';

const PRIMARY = (process.env.HAR_STORE_PRIMARY || (process.env.HAR_DATABASE_URL ? 'postgres' : 'sqlite')).toLowerCase();
const usePg = PRIMARY === 'postgres';

function wrapSync(fnName, ...args) {
  // sqlite sync API
  return sqlite[fnName](...args);
}

async function call(fnName, ...args) {
  if (usePg) {
    try {
      return await pg[fnName](...args);
    } catch (e) {
      console.warn(`[store] pg ${fnName} failed, fallback sqlite:`, e.message);
      return wrapSync(fnName, ...args);
    }
  }
  return wrapSync(fnName, ...args);
}

export function storeBackend() {
  return usePg ? 'postgres' : 'sqlite';
}

export async function initStore() {
  if (usePg) {
    await pg.initPg();
  } else {
    sqlite.initDb();
  }
  if (redisEnabled()) {
    const ok = await redisPing();
    console.log('[store] redis', ok ? 'ok' : 'down');
  }
  console.log('[store] primary =', storeBackend(), 'awsDualWrite =', awsEnabled());
}

export async function createSession(name) {
  return call('createSession', name);
}
export async function closeSession(sessionId) {
  return call('closeSession', sessionId);
}
export async function listSessions() {
  return call('listSessions');
}
export async function deleteSession(sessionId) {
  return call('deleteSession', sessionId);
}
export async function renameSession(sessionId, name) {
  return call('renameSession', sessionId, name);
}
export async function saveRequest(sessionId, req) {
  const out = await call('saveRequest', sessionId, req);
  awsPutRequest(sessionId, req);
  return out;
}
export async function updateRequest(sessionId, id, patch) {
  return call('updateRequest', sessionId, id, patch);
}
export async function appendWsMessage(sessionId, id, message) {
  return call('appendWsMessage', sessionId, id, message);
}
export async function loadRequests(sessionId, opts) {
  return call('loadRequests', sessionId, opts);
}
export async function countRequests(sessionId) {
  return call('countRequests', sessionId);
}
export async function saveCaptcha(sessionId, det) {
  return call('saveCaptcha', sessionId, det);
}
export async function loadCaptchas(sessionId) {
  return call('loadCaptchas', sessionId);
}
export async function clearRequests(sessionId) {
  return call('clearRequests', sessionId);
}
export async function setPref(key, value) {
  return call('setPref', key, value);
}
export async function getPref(key, fallback) {
  return call('getPref', key, fallback);
}
export async function getOrCreateActiveSession() {
  return call('getOrCreateActiveSession');
}
export async function saveCookie(sessionId, cookie) {
  const id = await call('saveCookie', sessionId, cookie);
  awsPutCookie(sessionId, cookie);
  await redisPushRecentCookie(sessionId, cookie);
  return id;
}
export async function saveCookiesBulk(sessionId, cookies) {
  const n = await call('saveCookiesBulk', sessionId, cookies);
  for (const c of cookies || []) {
    awsPutCookie(sessionId, c);
    await redisPushRecentCookie(sessionId, c);
  }
  return n;
}
export async function loadCookies(sessionId, opts) {
  return call('loadCookies', sessionId, opts);
}
export async function clearCookies(sessionId) {
  return call('clearCookies', sessionId);
}
export async function exportCookieJar(sessionId) {
  return call('exportCookieJar', sessionId);
}

export async function publishStatus(status) {
  await redisSetStatus(status);
}
