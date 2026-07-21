/**
 * Web adapter shim for desktop renderer.
 * Reuses the existing App.tsx + components (no rewrite) by exposing a
 * window.harSuite API that talks to our /api/* + /ws instead of Electron IPC.
 *
 * Mounted BEFORE the renderer bundle so that when App.tsx mounts it finds
 * window.harSuite already present.
 */
(() => {
  const apiHost = location.origin;
  const wsUrl = apiHost.replace(/^http/, 'ws') + '/ws';

  let ws = null;
  const listeners = {
    request: [],
    update: [],
    wsMessage: [],
    status: [],
    connection: [],
    cleared: [],
    reloaded: [],
    captcha: [],
    appStatus: [],
    cliStatus: [],
    commandOutput: [],
    appFilterChanged: [],
  };

  function fire(type, ...args) {
    for (const fn of listeners[type] || []) {
      try { fn(...args); } catch (e) { console.warn('[shim]', type, e); }
    }
  }

  function off(type, fn) {
    const arr = listeners[type];
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }

  function connectWs() {
    try {
      ws = new WebSocket(wsUrl);
    } catch { return; }
    ws.addEventListener('open', () => {
      // nothing to auth for UI
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
        case 'request':
          fire('request', msg.request);
          break;
        case 'update':
          fire('update', msg.id, msg.patch);
          break;
        case 'ws-message':
          fire('wsMessage', msg.id, msg.message);
          break;
        case 'captcha':
          fire('captcha', msg.captcha);
          break;
        case 'connection':
          fire('connection', { connected: msg.connected });
          fire('status', { connected: msg.connected });
          break;
        case 'status':
          fire('status', msg.connected != null ? { connected: msg.connected } : msg);
          fire('connection', msg.connected != null ? { connected: msg.connected } : msg);
          break;
        case 'cleared':
          fire('cleared', { sessionId: msg.sessionId ?? null });
          break;
        case 'reloaded':
          fire('reloaded', msg);
          break;
        case 'init':
          // initial bulk load is handled via HTTP; ws init is just noise
          break;
        default:
          break;
      }
    });
    ws.addEventListener('close', () => {
      setTimeout(connectWs, 2000);
    });
    ws.addEventListener('error', () => {
      try { ws.close(); } catch {}
    });
  }
  connectWs();

  async function http(path, opts = {}) {
    const res = await fetch(apiHost + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`${res.status} ${txt}`);
    }
    return res.json();
  }

  // Build window.harSuite that matches preload API surface.
  const api = {
    // data
    getAll: async () => {
      const data = await http('/api/requests?limit=5000');
      return data.requests ?? [];
    },
    clear: async () => {
      await http('/api/requests', { method: 'DELETE' });
      return true;
    },
    getStatus: async () => {
      const data = await http('/api/status');
      return {
        allowlist: data.allowlist || [],
        captureEnabled: data.capturing ?? data.captureEnabled ?? true,
        scope: data.scope || 'data',
        connected: !!data.connected,
        token: data.token || '',
        sessionId: data.sessionId ?? null,
        redaction: data.redaction,
        appFilter: data.appFilter,
        appFilterBypass: data.appFilterBypass,
      };
    },
    setAllowlist: async (domains) => {
      await http('/api/allowlist', { method: 'POST', body: JSON.stringify({ domains }) });
      return true;
    },
    setCapture: async (enabled) => {
      await http('/api/capture', { method: 'POST', body: JSON.stringify({ enabled }) });
      return true;
    },
    setScope: async (scope) => {
      await http('/api/capture', { method: 'POST', body: JSON.stringify({ enabled: true, scope }) });
      return true;
    },

    // sessions
    listSessions: async () => {
      const data = await http('/api/sessions');
      const list = data.sessions || [];
      // desktop Session has name, createdAt, closedAt, count
      return list;
    },
    currentSession: async () => {
      const data = await http('/api/session/current');
      return data.sessionId ?? null;
    },
    newSession: async (name) => {
      const data = await http('/api/sessions', { method: 'POST', body: JSON.stringify({ name }) });
      return data.id ?? data.currentId;
    },
    openSession: async (id) => {
      const data = await http(`/api/sessions/${id}/open`, { method: 'POST' });
      // Fire reloaded manually so App.tsx switches
      fire('reloaded', { sessionId: id, requests: data.requests || [], captchas: data.captchas || [] });
      return id;
    },
    deleteSession: async (id) => {
      await http(`/api/sessions/${id}`, { method: 'DELETE' });
      fire('cleared', { sessionId: null });
      return true;
    },
    renameSession: async (id, name) => {
      await http(`/api/sessions/${id}/rename`, { method: 'POST', body: JSON.stringify({ name }) });
      return true;
    },

    // captchas
    getCaptchas: async () => {
      const data = await http('/api/captchas');
      return data.captchas || [];
    },
    clearCaptchas: async () => true,
    copySitekey: async (id) => {
      // desktop does clipboard; web: return null and let RequestDetail handle copy
      return null;
    },

    // export
    exportData: async (format, ids) => {
      const data = await http('/api/export?limit=5000');
      return { ok: true, count: data.requests?.length || 0 };
    },
    importHar: async () => ({ ok: false, error: 'import-har not available on web' }),

    // converters — do client-side from request object if available, else no-op
    toCurl: async (id) => null,
    toFetch: async (id) => null,
    copyUrl: async (id) => null,

    // app-capture etc — unsupported on web, return stubs
    setAppCapture: async () => ({ ok: false, error: 'unsupported on web' }),
    getAppCaptureStatus: async () => ({ enabled: false, port: 0, proxyActive: false, supported: false }),
    runCommand: async () => ({ ok: false, error: 'unsupported on web' }),
    cancelCommand: async () => false,
    setGlobalEnv: async () => ({ ok: false, error: 'unsupported on web' }),
    getCliStatus: async () => ({ proxyRunning: false, globalEnvActive: false, commandRunning: false, supported: false }),
    getAppFilter: async () => ({ exeNames: [], bypass: false, seenExes: [], runningProcesses: [] }),
    setAppFilter: async () => false,
    setRedaction: async () => false,
    regenerateToken: async () => {
      const data = await http('/api/token/regenerate', { method: 'POST' });
      return data.token || '';
    },

    // subscriptions
    onRequest: (cb) => { listeners.request.push(cb); return () => off('request', cb); },
    onUpdate: (cb) => { listeners.update.push(cb); return () => off('update', cb); },
    onWsMessage: (cb) => { listeners.wsMessage.push(cb); return () => off('wsMessage', cb); },
    onStatus: (cb) => { listeners.status.push(cb); return () => off('status', cb); },
    onConnection: (cb) => { listeners.connection.push(cb); return () => off('connection', cb); },
    onCleared: (cb) => { listeners.cleared.push(cb); return () => off('cleared', cb); },
    onReloaded: (cb) => { listeners.reloaded.push(cb); return () => off('reloaded', cb); },
    onCaptcha: (cb) => { listeners.captcha.push(cb); return () => off('captcha', cb); },
    onAppCaptureStatus: (cb) => { listeners.appStatus.push(cb); return () => off('appStatus', cb); },
    onCliStatus: (cb) => { listeners.cliStatus.push(cb); return () => off('cliStatus', cb); },
    onCommandOutput: (cb) => { listeners.commandOutput.push(cb); return () => off('commandOutput', cb); },
    onAppFilterChanged: (cb) => { listeners.appFilterChanged.push(cb); return () => off('appFilterChanged', cb); },
  };

  window.harSuite = api;

  // Small banner so you know it's web shim
  console.log('[har-web] shim loaded, ws=%s', wsUrl);
})();
