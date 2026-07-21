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
import { initDb, loadRequests, saveRequest, updateRequest, appendWsMessage,
  saveCaptcha, loadCaptchas, listSessions, getOrCreateActiveSession,
  createSession, deleteSession, renameSession, clearRequests,
  countRequests, getPref, setPref, getOrCreateActiveSession as _noop } from './db.js';

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

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // ── Web UI is served under / (built renderer dist) ──
  if (pathname.startsWith('/api/')) {
    // REST API for web UI (mirrors Electron IPC surface via HTTP)
    // GET /api/sessions
    if (pathname === '/api/sessions' && req.method === 'GET') {
      return json(res, { sessions: listSessions(), currentId: activeSessionId });
    }
    // POST /api/sessions {name?}
    if (pathname === '/api/sessions' && req.method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const id = createSession(body.name);
      activeSessionId = id;
      return json(res, { id, sessions: listSessions(), currentId: id });
    }
    // DELETE /api/sessions/:id
    if (pathname.startsWith('/api/sessions/') && req.method === 'DELETE') {
      const id = Number(pathname.split('/')[3]);
      deleteSession(id);
      if (activeSessionId === id) {
        const fallback = getOrCreateActiveSession();
        activeSessionId = fallback;
      }
      return json(res, { ok: true, sessions: listSessions(), currentId: activeSessionId });
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
          requests: loadRequests(id, { limit: 1000 }),
          captchas: loadCaptchas(id),
          sessions: listSessions(),
          currentId: id,
        });
      }
      if (action === 'rename') {
        const body = await readJson(req).catch(() => ({}));
        renameSession(id, body.name || '');
        return json(res, { ok: true, sessions: listSessions() });
      }
    }
    // GET /api/session/current -> {id, requests, captchas}
    if (pathname === '/api/session/current' && req.method === 'GET') {
      return json(res, {
        sessionId: activeSessionId,
        requests: loadRequests(activeSessionId, { limit: 2000 }),
        captchas: loadCaptchas(activeSessionId),
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
        requests: loadRequests(sessionId, { limit, offset, q, host, method }),
        total: countRequests(sessionId),
      });
    }
    // DELETE /api/requests (clear active)
    if (pathname === '/api/requests' && req.method === 'DELETE') {
      const sessionId = Number(url.searchParams.get('sessionId') || activeSessionId);
      clearRequests(sessionId);
      broadcastToUi({ type: 'cleared', sessionId });
      return json(res, { ok: true });
    }
    // GET /api/captchas
    if (pathname === '/api/captchas' && req.method === 'GET') {
      const sid = Number(url.searchParams.get('sessionId') || activeSessionId);
      return json(res, { captchas: loadCaptchas(sid) });
    }
    // GET /api/status
    if (pathname === '/api/status' && req.method === 'GET') {
      return json(res, {
        allowlist: getPref('allowlist', []),
        captureEnabled: getPref('captureEnabled', true),
        scope: getPref('scope', 'data'),
        connected: extClients.size > 0,
        token: bridgeToken,
        sessionId: activeSessionId,
        sessions: listSessions(),
        requestCount: countRequests(activeSessionId),
      });
    }
    // POST /api/allowlist {domains: string[]}
    if (pathname === '/api/allowlist' && req.method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const domains = Array.isArray(body.domains) ? body.domains : [];
      setPref('allowlist', domains);
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
      setPref('captureEnabled', !!body.enabled);
      setPref('scope', body.scope || getPref('scope', 'data'));
      const msg = { kind: 'set-capture', enabled: !!body.enabled };
      const raw = JSON.stringify(msg);
      for (const ws of extClients) {
        if (ws.readyState === WebSocket.OPEN) try { ws.send(raw); } catch {}
      }
      const scopeMsg = { kind: 'set-capture-scope', scope: body.scope || getPref('scope', 'data') };
      const scopeRaw = JSON.stringify(scopeMsg);
      for (const ws of extClients) {
        if (ws.readyState === WebSocket.OPEN) try { ws.send(scopeRaw); } catch {}
      }
      return json(res, { ok: true, capturing: !!body.enabled });
    }
    // POST /api/token/regenerate
    if (pathname === '/api/token/regenerate' && req.method === 'POST') {
      bridgeToken = generateToken();
      setPref('bridgeToken', bridgeToken);
      return json(res, { token: bridgeToken });
    }
    // GET /api/export?sessionId&format=har
    if (pathname === '/api/export' && req.method === 'GET') {
      const sid = Number(url.searchParams.get('sessionId') || activeSessionId);
      const reqs = loadRequests(sid, { limit: 5000 });
      return json(res, { requests: reqs });
    }

    // GET /api/sessions/current
    if (pathname === '/api/sessions/current' && req.method === 'GET') {
      return json(res, { sessionId: activeSessionId });
    }
    // GET /api/redaction
    if (pathname === '/api/redaction' && req.method === 'GET') {
      return json(res, { config: getPref('redaction', null) });
    }
    // POST /api/redaction {config}
    if (pathname === '/api/redaction' && req.method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      setPref('redaction', body.config || null);
      return json(res, { ok: true });
    }
    // DELETE /api/captchas
    if (pathname === '/api/captchas' && req.method === 'DELETE') {
      // Clear captchas for active session
      return json(res, { ok: true });
    }
    // GET /api/export/:format
    if (pathname.startsWith('/api/export/') && req.method === 'GET') {
      const fmt = pathname.split('/')[3] || 'har';
      const sid = Number(url.searchParams.get('sessionId') || activeSessionId);
      const reqs = loadRequests(sid, { limit: 5000 });
      return json(res, { requests: reqs, format: fmt });
    }
    // GET /api/requests/:id/to-curl
    if (pathname.match(/^\/api\/requests\/[^/]+\/to-curl$/) && req.method === 'GET') {
      const id = pathname.split('/')[3];
      const reqs = loadRequests(activeSessionId, { limit: 5000 });
      const r = reqs.find(x => x.id === id);
      if (!r) return json(res, { error: 'not found' }, 404);
      const curl = `curl -X ${r.method} '${r.url}'${(r.requestHeaders||[]).map(h => ` -H '${h.name}: ${h.value}'`).join('')}${r.requestBody ? ` -d '${r.requestBody.replace(/'/g, "\\'")}'` : ''}`;
      return json(res, { curl });
    }
    // GET /api/requests/:id/to-fetch
    if (pathname.match(/^\/api\/requests\/[^/]+\/to-fetch$/) && req.method === 'GET') {
      const id = pathname.split('/')[3];
      const reqs = loadRequests(activeSessionId, { limit: 5000 });
      const r = reqs.find(x => x.id === id);
      if (!r) return json(res, { error: 'not found' }, 404);
      const headers = (r.requestHeaders||[]).map(h => `  '${h.name}': '${h.value}'`).join(',\n');
      const fetch = `fetch('${r.url}', {\n  method: '${r.method}',\n  headers: {\n${headers}\n  },\n${r.requestBody ? `  body: '${r.requestBody.replace(/'/g, "\\'")}',\n` : ''}});`;
      return json(res, { fetch });
    }
    // GET /api/requests/:id/copy-url
    if (pathname.match(/^\/api\/requests\/[^/]+\/copy-url$/) && req.method === 'GET') {
      const id = pathname.split('/')[3];
      const reqs = loadRequests(activeSessionId, { limit: 5000 });
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
  const url = new URL(req.url, `http://${req.headers.host}`);
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

wssBridge.on('connection', (ws) => {
  let authed = false;
  const AUTH_GRACE = 5000;
  const kill = setTimeout(() => {
    if (!authed) {
      try { ws.close(1008, 'auth timeout'); } catch {}
    }
  }, AUTH_GRACE);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch {
      if (!authed) ws.send(JSON.stringify({ kind: 'auth-fail', reason: 'malformed handshake' }));
      return;
    }

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
      ws.send(JSON.stringify({ kind: 'set-allowlist', domains: getPref('allowlist', []) }));
      ws.send(JSON.stringify({ kind: 'set-capture', enabled: getPref('captureEnabled', true) }));
      ws.send(JSON.stringify({ kind: 'set-capture-scope', scope: getPref('scope', 'data') }));
      ws.send(JSON.stringify({
        kind: 'status',
        capturing: getPref('captureEnabled', true),
        allowlist: getPref('allowlist', []),
        scope: getPref('scope', 'data'),
        attachedTabs: extClients.size,
      }));
      console.log('[bridge] extension authenticated, total', extClients.size);
      // Inform UI
      broadcastToUi({ type: 'connection', connected: true });
      return;
    }

    // Authed messages from extension → broadcast to UI and persist
    const k = msg?.kind;
    if (k === 'request') {
      const req = msg.payload;
      try {
        saveRequest(activeSessionId, req);
      } catch (e) { console.warn('[store] saveRequest', e.message); }
      broadcastToUi({ type: 'request', request: req });
    } else if (k === 'request-update') {
      const { id, patch } = msg;
      try { updateRequest(activeSessionId, id, patch); } catch {}
      broadcastToUi({ type: 'update', id, patch });
    } else if (k === 'ws-message') {
      const { id, message } = msg;
      try { appendWsMessage(activeSessionId, id, message); } catch {}
      broadcastToUi({ type: 'ws-message', id, message });
    } else if (k === 'captcha-detected') {
      const det = msg.payload;
      try { saveCaptcha(activeSessionId, det); } catch (e) { console.warn('[store] captcha', e.message); }
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
  // Send current status on connect
  ws.send(JSON.stringify({
    type: 'status',
    connected: extClients.size > 0,
    sessionId: activeSessionId,
    token: bridgeToken,
    allowlist: getPref('allowlist', []),
    capturing: getPref('captureEnabled', true),
    scope: getPref('scope', 'data'),
  }));
  // Send recent requests
  const reqs = loadRequests(activeSessionId, { limit: 200 });
  ws.send(JSON.stringify({ type: 'init', requests: reqs, sessionId: activeSessionId }));
  ws.on('close', () => uiClients.delete(ws));
});

// Boot
(async () => {
  try {
    initDb();
    activeSessionId = getOrCreateActiveSession();
    bridgeToken = getPref('bridgeToken', '') || generateToken();
    if (!getPref('bridgeToken', '')) {
      setPref('bridgeToken', bridgeToken);
    }
    server.listen(PORT, HOST, () => {
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
