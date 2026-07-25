/**
 * Redis helper for live HAR capture state.
 * Env: HAR_REDIS_URL (default redis://127.0.0.1:6379/0)
 */
import Redis from 'ioredis';

let redis = null;
const ENABLED = (process.env.HAR_REDIS_ENABLED ?? '1') !== '0';

export function redisEnabled() {
  return ENABLED && !!getRedis();
}

function getRedis() {
  if (!ENABLED) return null;
  if (redis) return redis;
  try {
    redis = new Redis(process.env.HAR_REDIS_URL || 'redis://127.0.0.1:6379/0', {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    redis.on('error', (e) => console.warn('[redis]', e.message));
    return redis;
  } catch (e) {
    console.warn('[redis] init failed', e.message);
    return null;
  }
}

export async function redisPing() {
  const r = getRedis();
  if (!r) return false;
  try {
    return (await r.ping()) === 'PONG';
  } catch {
    return false;
  }
}

export async function redisIncr(key, by = 1) {
  const r = getRedis();
  if (!r) return null;
  try {
    return await r.incrby(key, by);
  } catch {
    return null;
  }
}

export async function redisSetJson(key, value, ttlSec = 0) {
  const r = getRedis();
  if (!r) return;
  try {
    const payload = JSON.stringify(value);
    if (ttlSec > 0) await r.set(key, payload, 'EX', ttlSec);
    else await r.set(key, payload);
  } catch (e) {
    console.warn('[redis] set', e.message);
  }
}

export async function redisGetJson(key, fallback = null) {
  const r = getRedis();
  if (!r) return fallback;
  try {
    const v = await r.get(key);
    if (!v) return fallback;
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

export async function redisPushRecentCookie(sessionId, cookie, max = 200) {
  const r = getRedis();
  if (!r) return;
  const key = `har:session:${sessionId}:cookies:recent`;
  try {
    await r.lpush(key, JSON.stringify(cookie));
    await r.ltrim(key, 0, max - 1);
    await r.expire(key, 7 * 24 * 3600);
  } catch (e) {
    console.warn('[redis] cookie push', e.message);
  }
}

export async function redisListRecentCookies(sessionId, limit = 50) {
  const r = getRedis();
  if (!r) return [];
  try {
    const rows = await r.lrange(`har:session:${sessionId}:cookies:recent`, 0, limit - 1);
    return rows.map((x) => {
      try {
        return JSON.parse(x);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export async function redisSetStatus(obj) {
  await redisSetJson('har:status', obj, 60);
}

export async function redisMarkExtConnected(ip) {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set('har:ext:last', JSON.stringify({ ip, ts: Date.now() }), 'EX', 120);
    await r.sadd('har:ext:ips', ip || 'unknown');
    await r.expire('har:ext:ips', 3600);
  } catch {}
}
