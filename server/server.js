import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { promises as fs } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

// ── In-memory store ──
// sessionId is auto-increment int, active session is the open one.
// All data in memory; also persisted to SQLite (optional, low dep).
import {
  initStore, storeBackend, loadRequests, saveRequest, updateRequest, appendWsMessage,
  saveCaptcha, loadCaptchas, listSessions, getOrCreateActiveSession,
  createSession, deleteSession, renameSession, clearRequests,
  countRequests, getPref, setPref, saveCookie, saveCookiesBulk, loadCookies,
  clearCookies, exportCookieJar, publishStatus,
} from './store.js';
import { awsEnabled } from './aws-store.js';
import { buildHar } from './har-export.js';
import { redisEnabled, redisPing, redisMarkExtConnected } from './redis-store.js';

const BRIDGE_VERSION = 2;

// WS bridge state (same protocol as desktop BridgeServer)
const extClients = new Set();
const uiClients = new Set();
let bridgeToken = '';
let activeSessionId = 1;

function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let t = '';
  for (let i = 0; i < 12; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

const MAX_BODY = Number(process.env.HAR_MAX_BODY || 200000);
const BODY_KEEP_TYPES = new Set(['XHR', 'Fetch', 'Document', 'Script', 'Other', 'WebSocket', 'Ping', 'EventSource']);
const BODY_DROP_TYPES = new Set(['Image', 'Stylesheet', 'Font', 'Media', 'TextTrack', 'Prefetch', 'Manifest']);

function truncateBodies(req) {
  if (!req || typeof req !== 'object') return req;
  const out = { ...req };
  const type = out.type || 'Other';
  // Never keep bodies for static assets
  if (BODY_DROP_TYPES.has(type)) {
    if (out.responseBody) {
      out.responseBody = undefined;
      out.responseBodyDropped = true;
    }
    if (out.requestBody && type !== 'Document') {
      // keep form POST bodies on Document; drop request bodies on pure static types
      out.requestBody = undefined;
      out.requestBodyDropped = true;
    }
    return out;
  }
  // Only keep full-ish bodies for data-like types
  if (!BODY_KEEP_TYPES.has(type)) {
    if (typeof out.responseBody === 'string' && out.responseBody.length > 4096) {
      out.responseBody = out.responseBody.slice(0, 4096);
      out.responseBodyTruncated = true;
    }
  }
  if (typeof out.responseBody === 'string' && out.responseBody.length > MAX_BODY) {
    out.responseBody = out.responseBody.slice(0, MAX_BODY);
    out.responseBodyTruncated = true;
  }
  if (typeof out.requestBody === 'string' && out.requestBody.length > MAX_BODY) {
    out.requestBody = out.requestBody.slice(0, MAX_BODY);
    out.requestBodyTruncated = true;
  }
  return out;
}

function toNetscapeCookieJar(jar) {
  const lines = ['# Netscape HTTP Cookie File', '# https://curl.se/docs/http-cookies.html', ''];
  for (const c of jar || []) {
    const domain = c.domain || c.host || '';
    const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const path = c.path || '/';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const exp = '0';
    lines.push([domain || (c.host || ''), includeSub, path, secure, exp, c.name || '', c.value || ''].join('\t'));
  }
  return lines.join('\n');
}

function groupCookieHeaders(jar) {
  const byHost = {};
  for (const c of jar || []) {
    const h = c.host || c.domain || 'unknown';
    if (!byHost[h]) byHost[h] = [];
    byHost[h].push(`${c.name}=${c.value}`);
  }
  const headers = {};
  for (const [h, parts] of Object.entries(byHost)) headers[h] = parts.join('; ');
  return headers;
}

let lastCookieAt = 0;
let lastRequestAt = 0;
let lastExtEventAt = 0;

async function persistRequest(sessionId, req) {
  const slim = truncateBodies(req);
  try { await saveRequest(sessionId, slim); } catch (e) { console.warn('[store] saveRequest', e.message); }
  lastRequestAt = Date.now();
  lastExtEventAt = lastRequestAt;
  return slim;
}

async function persistCookieRows(sessionId, rows) {
  try { await saveCookiesBulk(sessionId, rows); } catch (e) { console.warn('[store] cookies', e.message); }
  if (rows?.length) {
    lastCookieAt = Date.now();
    lastExtEventAt = lastCookieAt;
  }
}

function broadcastToUi(obj) {
  const raw = JSON.stringify(obj);
  for (const ws of uiClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(raw); } catch {}
    }
  }
}

function sendTo(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
}

// ── HTTP server + API ──
async function serveFile(res, filePath) {
  try {
    const data = await fs.readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript',
      '.mjs': 'application/javascript',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.map': 'application/json',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function json(res, obj, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    });
    return res.end();
  }

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Bad Request');
  }
  const pathname = url.pathname;

  // ── Web UI is served under / (built renderer dist) ──
  if (pathname.startsWith('/api/')) {
    // REST API for web UI (mirrors Electron IPC surface via HTTP)
    // GET /api/sessions
    if (pathname === '/api/sessions' && req.method === 'GET') {
      return json(res, { sessions: await listSessions(), currentId: activeSessionId });
    }
    // POST /api/sessions {name?}
    if (pathname === '/api/sessions' && req.method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const id = await createSession(body.name);
      activeSessionId = id;
      return json(res, { id, sessions: await listSessions(), currentId: id });
    }
    // DELETE /api/sessions/:id
    if (pathname.startsWith('/api/sessions/') && req.method === 'DELETE') {
      const id = Number(pathname.split('/')[3]);
      await deleteSession(id);
      if (activeSessionId === id) {
        const fallback = await getOrCreateActiveSession();
        activeSessionId = fallback;
      }
      return json(res, { ok: true, sessions: await listSessions(), currentId: activeSessionId });
    }
    // POST /api/sessions/:id/open | rename
    if (pathname.startsWith('/api/sessions/') && req.method === 'POST') {
      const parts = pathname.split('/');
      const id = Number(parts[3]);
      const action = parts[4];
      if (action === 'open') {
        activeSessionId = id;
        return json(res, {
          sessionId: id,
          requests: await loadRequests(id, { limit: 1000 }),
          captchas: await loadCaptchas(id),
          sessions: await listSessions(),
          currentId: id,
        });
      }
      if (action === 'rename') {
        const body = await readJson(req).catch(() => ({}));
        await renameSession(id, body.name || '');
        return json(res, { ok: true, sessions: await listSessions() });
      }
    }
    // GET /api/session/current -> {id, requests, captchas}
    if (pathname === '/api/session/current' && req.method === 'GET') {
      return json(res, {
        sessionId: activeSessionId,
        requests: await loadRequests(activeSessionId, { limit: 2000 }),
        captchas: await loadCaptchas(activeSessionId),
      });
    }
    // GET /api/requests?limit&offset&q&host&method
    if (pathname === '/api/requests' && req.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit') || 500), 2000);
      const offset = Number(url.searchParams.get('offset') || 0);
      const q = url.searchParams.get('q') || '';
      const host = url.searchParams.get('host') || '';
      const method = url.searchParams.get('method') || '';
      const sessionId = Number(url.searchParams.get('sessionId') || activeSessionId);
      return json(res, {
        requests: await loadRequests(sessionId, { limit, offset, q, host, method }),
        total: await countRequests(sessionId),
      });
    }
    // DELETE /api/requests (clear active)
    if (pathname === '/api/requests' && req.method === 'DELETE') {
      const sessionId = Number(url.searchParams.get('sessionId') || activeSessionId);
      await clearRequests(sessionId);
      broadcastToUi({ type: 'cleared', sessionId });
      return json(res, { ok: true });
    }
    // GET /api/captchas
    if (pathname === '/api/captchas' && req.method === 'GET') {
      const sid = Number(url.searchParams.get('sessionId') || activeSessionId);
      return json(res, { captchas: await loadCaptchas(sid) });
    }
    // GET /api/status
    if (pathname === '/api/status' && req.method === 'GET') {
      const cookieCount = (await loadCookies(activeSessionId, { limit: 5000 })).length;
      let redisOk = false;
      try {
        const { redisPing } = await import('./redis-store.js');
        redisOk = await redisPing();
      } catch {}
      let dbOk = true;
      try { await countRequests(activeSessionId); } catch { dbOk = false; }
      const now = Date.now();
      return json(res, {
        cookieCount,
        awsDualWrite: awsEnabled(),
        backend: storeBackend(),
        redis: redisEnabled(),
        redisOk,
        dbOk,
        health: {
          ok: dbOk && (extClients.size >= 0),
          extensionConnected: extClients.size > 0,
          extensionClients: extClients.size,
          lastCookieAt,
          lastRequestAt,
          lastExtEventAt,
          cookieAgeMs: lastCookieAt ? now - lastCookieAt : null,
          requestAgeMs: lastRequestAt ? now - lastRequestAt : null,
          uptimeSec: Math.floor(process.uptime()),
        },
        allowlist: await getPref('allowlist', []),
        captureEnabled: await getPref('captureEnabled', true),
        scope: await getPref('scope', 'data'),
        connected: extClients.size > 0,
        token: bridgeToken,
        sessionId: activeSessionId,
        sessions: await listSessions(),
        requestCount: await countRequests(activeSessionId),
      });
    }
    // GET /api/health — compact operator health
    if (pathname === '/api/health' && req.method === 'GET') {
      let redisOk = false;
      try {
        const { redisPing } = await import('./redis-store.js');
        redisOk = await redisPing();
      } catch {}
      let dbOk = true;
      try { await countRequests(activeSessionId); } catch { dbOk = false; }
      return json(res, {
        ok: dbOk,
        backend: storeBackend(),
        redisOk,
        awsDualWrite: awsEnabled(),
        extensionConnected: extClients.size > 0,
        extensionClients: extClients.size,
        lastCookieAt,
        lastRequestAt,
        lastExtEventAt,
        sessionId: activeSessionId,
        uptimeSec: Math.floor(process.uptime()),
      });
    }
    // POST /api/allowlist {domains: string[]}
    if (pathname === '/api/allowlist' && req.method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const domains = Array.isArray(body.domains) ? body.domains : [];
      await setPref('allowlist', domains);
      // Push to extensions
      const msg = { kind: 'set-allowlist', domains };
      const raw = JSON.stringify(msg);
      for (const ws of extClients) {
        if (ws.readyState === WebSocket.OPEN) try { ws.send(raw); } catch {}
      }
      return json(res, { ok: true, allowlist: domains });
    }
    // POST /api/capture {enabled: bool}
    if (pathname === '/api/capture' && req.method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      await setPref('captureEnabled', !!body.enabled);
      await setPref('scope', body.scope || (await getPref('scope', 'data')));
      const msg = { kind: 'set-capture', enabled: !!body.enabled };
      const raw = JSON.stringify(msg);
      for (const ws of extClients) {
        if (ws.readyState === WebSocket.OPEN) try { ws.send(raw); } catch {}
      }
      const scopeMsg = { kind: 'set-capture-scope', scope: body.scope || (await getPref('scope', 'data')) };
      const scopeRaw = JSON.stringify(scopeMsg);
      for (const ws of extClients) {
        if (ws.readyState === WebSocket.OPEN) try { ws.send(scopeRaw); } catch {}
      }
      return json(res, { ok: true, capturing: !!body.enabled });
    }
    // POST /api/token/regenerate
    if (pathname === '/api/token/regenerate' && req.method === 'POST') {
      bridgeToken = generateToken();
      await setPref('bridgeToken', bridgeToken);
      return json(res, { token: bridgeToken });
    }
    // GET /api/export?sessionId&format=har
    if (pathname === '/api/export' && req.method === 'GET') {
      const sid = Number(url.searchParams.get('sessionId') || activeSessionId);
      const reqs = await loadRequests(sid, { limit: 5000 });
      return json(res, { requests: reqs });
    }

    // GET /api/sessions/current
    if (pathname === '/api/sessions/current' && req.method === 'GET') {
      return json(res, { sessionId: activeSessionId });
    }
    // GET /api/redaction
    if (pathname === '/api/redaction' && req.method === 'GET') {
      return json(res, { config: await getPref('redaction', null) });
    }
    // POST /api/redaction {config}
    if (pathname === '/api/redaction' && req.method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      await setPref('redaction', body.config || null);
      return json(res, { ok: true });
    }
    // DELETE /api/captchas
    if (pathname === '/api/captchas' && req.method === 'DELETE') {
      // Clear captchas for active session
      return json(res, { ok: true });
    }
    // GET /api/bridge/poll — HTTP polling fallback for extensions that can't use WebSocket
    if (pathname === '/api/bridge/poll' && req.method === 'GET') {
      const token = url.searchParams.get('token') || '';
      if (bridgeToken && token !== bridgeToken) {
        return json(res, { error: 'invalid token' }, 401);
      }
      return json(res, {
        ok: true,
        allowlist: await getPref('allowlist', []),
        captureEnabled: await getPref('captureEnabled', true),
        scope: await getPref('scope', 'data'),
        sessionId: activeSessionId,
        connected: true,
      });
    }
    // POST /api/bridge/send — HTTP send fallback for extensions
    if (pathname === '/api/bridge/send' && req.method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const token = body.token || url.searchParams.get('token') || '';
      if (bridgeToken && token !== bridgeToken) {
        return json(res, { error: 'invalid token' }, 401);
      }
      // Process the message same as WS bridge
      const k = body.kind;
      if (k === 'request') {
        const req2 = await persistRequest(activeSessionId, body.payload || {});
        broadcastToUi({ type: 'request', request: req2 });
      } else if (k === 'request-update') {
        const { id, patch } = body;
        try { await updateRequest(activeSessionId, id, patch); } catch {}
        broadcastToUi({ type: 'update', id, patch });
      } else if (k === 'ws-message') {
        const { id, message } = body;
        try { await appendWsMessage(activeSessionId, id, message); } catch {}
        broadcastToUi({ type: 'ws-message', id, message });
      } else if (k === 'captcha-detected') {
        const det = body.payload;
        try { await saveCaptcha(activeSessionId, det); } catch (e) { console.warn('[store] captcha', e.message); }
        broadcastToUi({ type: 'captcha', captcha: det });
      } else if (k === 'cookie-snapshot') {
        const host = body.host || '';
        const url = body.url || '';
        const rows = (body.cookies || []).map((c) => ({ host, url, name: c.name, value: c.value, domain: c.domain, httpOnly: !!c.httpOnly, secure: !!c.secure, path: c.path, sameSite: c.sameSite || null, partitionKey: c.partitionKey ? JSON.stringify(c.partitionKey) : null, expirationDate: c.expirationDate || null, source: 'cookie-snapshot', ts: Date.now() }));
        console.log('[bridge] cookie-snapshot (http) from', host, ':', rows.map((c) => c.name).join(', '));
        await persistCookieRows(activeSessionId, rows);
        broadcastToUi({ type: 'cookie-snapshot', host, url, cookies: body.cookies, sessionId: activeSessionId });
      } else if (k === 'set-cookie-capture') {
        const host = body.host || '';
        const url = body.url || '';
        const rows = (body.cookies || []).map((raw) => {
          const s = String(raw || '');
          const name = s.split('=')[0]?.trim() || '';
          const value = s.slice(name.length + 1).split(';')[0] || '';
          return { host, url, name, value, domain: host, httpOnly: /httponly/i.test(s), secure: /secure/i.test(s), path: (s.match(/path=([^;]+)/i) || [])[1] || null, sameSite: ((s.match(/samesite=([^;]+)/i) || [])[1] || '').trim() || null, partitionKey: /partitioned/i.test(s) ? 'Partitioned' : null, source: 'set-cookie', raw: s, ts: Date.now() };
        });
        console.log('[bridge] set-cookie-capture (http) from', host, ':', rows.map((c) => c.name).join(', '));
        await persistCookieRows(activeSessionId, rows);
        broadcastToUi({ type: 'set-cookie-capture', host, url, cookies: body.cookies, sessionId: activeSessionId });
      }
      return json(res, { ok: true });
    }
    // GET /api/cookies
    if (pathname === '/api/cookies' && req.method === 'GET') {
      const sid = Number(url.searchParams.get('sessionId') || activeSessionId);
      const limit = Math.min(Number(url.searchParams.get('limit') || 500), 5000);
      const host = url.searchParams.get('host') || '';
      const name = url.searchParams.get('name') || '';
      let cookies = await loadCookies(sid, { limit, host, name });
      if (url.searchParams.get('httpOnly') === '1') cookies = cookies.filter((c) => c.httpOnly);
      return json(res, { cookies, sessionId: sid, aws: awsEnabled(), backend: storeBackend(), redis: redisEnabled() });
    }
    // GET /api/cookies/export?format=json|header|netscape|latest
    if (pathname === '/api/cookies/export' && req.method === 'GET') {
      const sid = Number(url.searchParams.get('sessionId') || activeSessionId);
      const format = (url.searchParams.get('format') || 'json').toLowerCase();
      const host = url.searchParams.get('host') || '';
      let jar = await exportCookieJar(sid);
      if (host) jar = jar.filter((c) => (c.host || '').includes(host) || (c.domain || '').includes(host));
      const headersByHost = groupCookieHeaders(jar);
      const asHeader = jar.map((c) => `${c.name}=${c.value}`).join('; ');
      if (format === 'netscape' || format === 'txt') {
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': 'attachment; filename="cookies.txt"',
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(toNetscapeCookieJar(jar));
      }
      if (format === 'header') {
        return json(res, { sessionId: sid, count: jar.length, cookieHeader: asHeader, headersByHost });
      }
      if (format === 'latest') {
        return json(res, { sessionId: sid, count: jar.length, jar, cookieHeader: asHeader, headersByHost });
      }
      return json(res, { sessionId: sid, count: jar.length, jar, cookieHeader: asHeader, headersByHost, netscape: toNetscapeCookieJar(jar) });
    }
    // DELETE /api/cookies
    if (pathname === '/api/cookies' && req.method === 'DELETE') {
      const sid = Number(url.searchParams.get('sessionId') || activeSessionId);
      await clearCookies(sid);
      return json(res, { ok: true });
    }
    // GET /api/export/:format  (har | json | zip-meta)
    if ((pathname.startsWith('/api/export/') || pathname === '/api/export') && req.method === 'GET') {
      const fmt = (pathname.startsWith('/api/export/') ? pathname.split('/')[3] : url.searchParams.get('format')) || 'har';
      const sid = Number(url.searchParams.get('sessionId') || activeSessionId);
      const reqs = await loadRequests(sid, { limit: 5000 });
      if (fmt === 'json') return json(res, { sessionId: sid, count: reqs.length, requests: reqs });
      const har = buildHar(reqs, { creatorVersion: '0.4.1' });
      if (fmt === 'har' || fmt === 'har.json') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="session-${sid}.har"`,
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(JSON.stringify(har, null, 2));
      }
      return json(res, { sessionId: sid, format: fmt, har, count: reqs.length });
    }
    // GET /api/requests/:id/to-curl
    if (pathname.match(/^\/api\/requests\/[^/]+\/to-curl$/) && req.method === 'GET') {
      const id = pathname.split('/')[3];
      const reqs = await loadRequests(activeSessionId, { limit: 5000 });
      const r = reqs.find(x => x.id === id);
      if (!r) return json(res, { error: 'not found' }, 404);
      const curl = `curl -X ${r.method} '${r.url}'${(r.requestHeaders||[]).map(h => ` -H '${h.name}: ${h.value}'`).join('')}${r.requestBody ? ` -d '${r.requestBody.replace(/'/g, "\\'")}'` : ''}`;
      return json(res, { curl });
    }
    // GET /api/requests/:id/to-fetch
    if (pathname.match(/^\/api\/requests\/[^/]+\/to-fetch$/) && req.method === 'GET') {
      const id = pathname.split('/')[3];
      const reqs = await loadRequests(activeSessionId, { limit: 5000 });
      const r = reqs.find(x => x.id === id);
      if (!r) return json(res, { error: 'not found' }, 404);
      const headers = (r.requestHeaders||[]).map(h => `  '${h.name}': '${h.value}'`).join(',\n');
      const fetch = `fetch('${r.url}', {\n  method: '${r.method}',\n  headers: {\n${headers}\n  },\n${r.requestBody ? `  body: '${r.requestBody.replace(/'/g, "\\'")}',\n` : ''}});`;
      return json(res, { fetch });
    }
    // GET /api/requests/:id/copy-url
    if (pathname.match(/^\/api\/requests\/[^/]+\/copy-url$/) && req.method === 'GET') {
      const id = pathname.split('/')[3];
      const reqs = await loadRequests(activeSessionId, { limit: 5000 });
      const r = reqs.find(x => x.id === id);
      if (!r) return json(res, { error: 'not found' }, 404);
      return json(res, { url: r.url });
    }
    return json(res, { error: 'not found' }, 404);
  }

  // ── Serve built renderer if available (dist) ──
  const distDir = join(__dirname, 'public');
  // Map / -> /index.html, /assets/* etc.
  if (pathname === '/' || pathname === '/index.html') {
    // Try web build first (server/public/index.html) then desktop build
    for (const p of [join(distDir, 'index.html'), join(__dirname, '..', 'desktop-app', 'out', 'renderer', 'index.html')]) {
      if (await serveFile(res, p)) return;
    }
    // Fallback minimal UI if no build present
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><head><meta charset=\"utf-8\"><title>HAR Capture</title>
    <style>body{font-family:system-ui;background:#15171c;color:#e8eaed;margin:0;padding:24px}pre{overflow:auto;max-height:50vh;background:#1b1e24;padding:12px;border-radius:8px}</style>
    </head><body><h1>HAR Capture Suite</h1><p>Build renderer not found. Run <code>npm run build:web</code> to bundle the UI.</p>
    <p>Bridge WS: <code>/bridge/ws</code> | API: <code>/api/*</code> | Domain: <code>capture.eemaill.codes</code></p>
    <p>Extension should point to <code>wss://capture.eemaill.codes/bridge/ws</code></p></body></html>`);
  }

  // Try serve from public/ (web build)
  if (await serveFile(res, join(distDir, pathname.slice(1)))) return;
  // Fallback assets
  for (const base of [join(__dirname, '..', 'desktop-app', 'out', 'renderer'), join(distDir, 'assets'), join(distDir)]) {
    if (await serveFile(res, join(base, pathname.replace(/^\/assets\//, '')))) return;
  }

  // SPA fallback — serve index.html for unknown routes (client router)
  if (!pathname.includes('.') ) {
    for (const p of [join(distDir, 'index.html'), join(__dirname, '..', 'desktop-app', 'out', 'renderer', 'index.html')]) {
      if (await serveFile(res, p)) return;
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── WS bridge: two endpoints — /bridge/ws for extensions, /ws for UI ──
const wssBridge = new WebSocketServer({ noServer: true, path: '/bridge/ws' });
const wssUi = new WebSocketServer({ noServer: true, path: '/ws' });

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    socket.destroy();
    return;
  }
  console.log('[ws] upgrade request:', url.pathname, 'from:', req.headers['x-forwarded-for'] || req.socket.remoteAddress);
  if (url.pathname === '/bridge/ws') {
    wssBridge.handleUpgrade(req, socket, head, (ws) => wssBridge.emit('connection', ws, req));
  } else if (url.pathname === '/ws') {
    wssUi.handleUpgrade(req, socket, head, (ws) => {
      wssUi.emit('connection', ws, req);
    });
  } else {
    // Also accept plain /bridge (legacy desktop)
    const legacy = url.pathname === '/bridge' || url.pathname === '/ws-bridge' || url.pathname.startsWith('/bridge');
    if (legacy) {
      wssBridge.handleUpgrade(req, socket, head, (ws) => wssBridge.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  }
});

wssBridge.on('connection', (ws, req) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log('[bridge] new connection from', clientIp);
  let authed = false;
  const AUTH_GRACE = 8000;
  const kill = setTimeout(() => {
    if (!authed) {
      console.log('[bridge] auth timeout from', clientIp);
      try { ws.close(1008, 'auth timeout'); } catch {}
    }
  }, AUTH_GRACE);

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch {
      if (!authed) ws.send(JSON.stringify({ kind: 'auth-fail', reason: 'malformed handshake' }));
      return;
    }
    console.log('[bridge] message:', msg.kind, 'from:', clientIp);

    if (!authed) {
      if (msg?.kind !== 'auth') {
        ws.send(JSON.stringify({ kind: 'auth-fail', reason: 'must auth first' }));
        try { ws.close(1008, 'auth'); } catch {}
        return;
      }
      const expected = bridgeToken;
      const hasProtocol = msg.protocol == null ? true : msg.protocol === BRIDGE_VERSION;
      if (!hasProtocol) {
        ws.send(JSON.stringify({ kind: 'auth-fail', reason: `protocol mismatch need v${BRIDGE_VERSION}` }));
        try { ws.close(); } catch {}
        return;
      }
      // If token is set, require exact match. If empty, allow (first run).
      if (expected && msg.token !== expected) {
        ws.send(JSON.stringify({ kind: 'auth-fail', reason: 'invalid token' }));
        try { ws.close(1008, 'bad token'); } catch {}
        return;
      }
      authed = true;
      clearTimeout(kill);
      extClients.add(ws);
      ws.send(JSON.stringify({ kind: 'auth-ok' }));
      // Push current config
      ws.send(JSON.stringify({ kind: 'set-allowlist', domains: await getPref('allowlist', []) }));
      ws.send(JSON.stringify({ kind: 'set-capture', enabled: await getPref('captureEnabled', true) }));
      ws.send(JSON.stringify({ kind: 'set-capture-scope', scope: await getPref('scope', 'data') }));
      ws.send(JSON.stringify({
        kind: 'status',
        capturing: await getPref('captureEnabled', true),
        allowlist: await getPref('allowlist', []),
        scope: await getPref('scope', 'data'),
        attachedTabs: extClients.size,
      }));
      console.log('[bridge] extension authenticated, total', extClients.size);
      // Inform UI
      broadcastToUi({ type: 'connection', connected: true });
      return;
    }

    // Authed messages from extension → broadcast to UI and persist
    const k = msg?.kind;
    if (k === 'ping') {
      // Keepalive from extension, just acknowledge
      try { ws.send(JSON.stringify({ kind: 'pong' })); } catch {}
    } else if (k === 'cookie-snapshot') {
      const host = msg.host || '';
      const url = msg.url || '';
      const rows = (msg.cookies || []).map((c) => ({
        host,
        url,
        name: c.name,
        value: c.value,
        domain: c.domain,
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        path: c.path,
        sameSite: c.sameSite || null,
        partitionKey: c.partitionKey ? JSON.stringify(c.partitionKey) : null,
        expirationDate: c.expirationDate || null,
        source: 'cookie-snapshot',
        ts: Date.now(),
      }));
      console.log('[bridge] cookie-snapshot from', host, ':', rows.map((c) => c.name).join(', '));
      await persistCookieRows(activeSessionId, rows);
      broadcastToUi({ type: 'cookie-snapshot', host, url, cookies: msg.cookies, sessionId: activeSessionId });
    } else if (k === 'set-cookie-capture') {
      const host = msg.host || '';
      const url = msg.url || '';
      const rows = (msg.cookies || []).map((raw) => {
        const s = String(raw || '');
        const name = s.split('=')[0]?.trim() || '';
        const value = s.slice(name.length + 1).split(';')[0] || '';
        return {
          host,
          url,
          name,
          value,
          domain: host,
          httpOnly: /httponly/i.test(s),
          secure: /secure/i.test(s),
          path: (s.match(/path=([^;]+)/i) || [])[1] || null,
          source: 'set-cookie',
          raw: s,
          ts: Date.now(),
        };
      });
      console.log('[bridge] set-cookie-capture from', host, ':', rows.map((c) => c.name).join(', '));
      await persistCookieRows(activeSessionId, rows);
      broadcastToUi({ type: 'set-cookie-capture', host, url, cookies: msg.cookies, sessionId: activeSessionId });
    } else if (k === 'request') {
      const req = await persistRequest(activeSessionId, msg.payload || {});
      broadcastToUi({ type: 'request', request: req });
    } else if (k === 'request-update') {
      const { id, patch } = msg;
      try { await updateRequest(activeSessionId, id, patch); } catch {}
      broadcastToUi({ type: 'update', id, patch });
    } else if (k === 'ws-message') {
      const { id, message } = msg;
      try { await appendWsMessage(activeSessionId, id, message); } catch {}
      broadcastToUi({ type: 'ws-message', id, message });
    } else if (k === 'captcha-detected') {
      const det = msg.payload;
      try { await saveCaptcha(activeSessionId, det); } catch (e) { console.warn('[store] captcha', e.message); }
      broadcastToUi({ type: 'captcha', captcha: det });
    } else {
      // relay other bridge messages to UI as-is
      broadcastToUi({ type: 'bridge-message', message: msg });
    }
  });

  ws.on('close', () => {
    clearTimeout(kill);
    if (authed) {
      extClients.delete(ws);
      if (extClients.size === 0) broadcastToUi({ type: 'connection', connected: false });
      console.log('[bridge] extension disconnected, remaining', extClients.size);
    }
  });
});

wssUi.on('connection', (ws) => {
  uiClients.add(ws);
  (async () => {
    try {
      ws.send(JSON.stringify({
        type: 'status',
        connected: extClients.size > 0,
        sessionId: activeSessionId,
        token: bridgeToken,
        allowlist: await getPref('allowlist', []),
        capturing: await getPref('captureEnabled', true),
        scope: await getPref('scope', 'data'),
      }));
      const reqs = await loadRequests(activeSessionId, { limit: 200 });
      ws.send(JSON.stringify({ type: 'init', requests: reqs, sessionId: activeSessionId }));
    } catch (e) {
      console.warn('[ui] init send failed', e.message);
    }
  })();
  ws.on('close', () => uiClients.delete(ws));
});

// Boot
(async () => {
  try {
    await initStore();
    activeSessionId = await getOrCreateActiveSession();
    const existingTok = await getPref('bridgeToken', '');
    bridgeToken = existingTok || generateToken();
    if (!existingTok) {
      await setPref('bridgeToken', bridgeToken);
    }
    // Prefer stable known token if env set
    if (process.env.HAR_BRIDGE_TOKEN) bridgeToken = process.env.HAR_BRIDGE_TOKEN;
    server.listen(PORT, HOST, () => {
      console.log(`[server] store=${storeBackend()} redis=${redisEnabled()} aws=${awsEnabled()}`);
      console.log(`[server] listening on ${HOST}:${PORT}`);
      console.log(`[server] active session ${activeSessionId}, token ${bridgeToken}`);
      console.log(`[server] bridge ws: /bridge/ws  ui ws: /ws  api: /api/*`);
      console.log(`[server] UI: http://${HOST}:${PORT}/ (public/ or renderer build)`);
    });
  } catch (e) {
    console.error('[server] boot failed', e);
    process.exit(1);
  }
})();
