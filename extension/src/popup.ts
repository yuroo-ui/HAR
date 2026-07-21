import type { CaptureScope } from '@har-suite/shared';

type RecentHost = { host: string; count: number; last: number };
type State = {
  capturing: boolean;
  allowlist: string[];
  scope: CaptureScope;
  connected: boolean;
  attachedTabs: number;
  token: string;
  recentHosts: RecentHost[];
  activeTabSticky: boolean;
};

const $ = (id: string) => document.getElementById(id) as HTMLElement;

async function getActiveTabId(): Promise<number | undefined> {
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    return t?.id ?? undefined;
  } catch {
    return undefined;
  }
}

async function getState(): Promise<State> {
  const tabId = await getActiveTabId();
  return await chrome.runtime.sendMessage({ kind: 'popup-get-state', tabId });
}

async function getRemoteState(): Promise<{ ok: boolean; enabled: boolean; url: string; token: string }> {
  try {
    return await chrome.runtime.sendMessage({ kind: 'popup-get-remote-state' });
  } catch {
    return { ok: false, enabled: false, url: '', token: '' };
  }
}

const SCOPE_HINTS: Record<CaptureScope, string> = {
  data: 'Captures XHR/Fetch/WebSocket, page loads, form-POST signups (Document), beacons. Skips images, CSS, fonts, scripts.',
  all: 'Captures every resource type, including static assets. Larger HARs.',
};

function activeTabHost(): Promise<string> {
  return chrome.tabs
    .query({ active: true, currentWindow: true })
    .then(([t]) => {
      if (!t?.url) return '';
      try {
        return new URL(t.url).host;
      } catch {
        return '';
      }
    })
    .catch(() => '');
}

function renderRecent(hosts: RecentHost[], allowlist: string[]) {
  const list = $('recent-list');
  list.innerHTML = '';
  if (hosts.length === 0) {
    list.innerHTML = '<div class="empty">No recent activity yet. Visit some sites.</div>';
    return;
  }
  for (const h of hosts) {
    const row = document.createElement('div');
    row.className = 'recent-item';
    const inList = allowlist.includes(h.host);
    row.innerHTML = `
      <span class="host" title="${h.host}">${h.host}</span>
      <span class="count">${h.count}×</span>
      <button class="add ${inList ? 'in' : ''}" data-host="${h.host}">${inList ? '✓ added' : '＋ add'}</button>
    `;
    list.appendChild(row);
  }
  list.querySelectorAll('button.add').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const host = (btn as HTMLButtonElement).dataset.host!;
      const s = await getState();
      if (s.allowlist.includes(host)) return;
      const next = Array.from(new Set([...s.allowlist, host]));
      await chrome.runtime.sendMessage({ kind: 'popup-set-allowlist', domains: next });
      render(await getState());
    });
  });
}

function renderScope(scope: CaptureScope) {
  for (const btn of document.querySelectorAll('#scope button')) {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.scope === scope);
  }
  $('scope-hint').textContent = SCOPE_HINTS[scope];
}

async function render(state: State) {
  ($('capture') as HTMLInputElement).checked = state.capturing;

  $('capture-sub').textContent = state.capturing
    ? state.attachedTabs > 0
      ? `Active · ${state.attachedTabs} tab${state.attachedTabs === 1 ? '' : 's'} capturing`
      : state.allowlist.length
        ? 'On · visit an allowlisted site'
        : 'On · add a domain to start'
    : 'Off';

  renderScope(state.scope);

  const allowlistEl = $('allowlist') as HTMLTextAreaElement;
  if (document.activeElement !== allowlistEl) {
    const fromState = state.allowlist.join('\n');
    if (allowlistEl.value !== fromState) allowlistEl.value = fromState;
  }
  const tokenEl = $('token') as HTMLInputElement;
  if (document.activeElement !== tokenEl) {
    const fromState = state.token ?? '';
    if (tokenEl.value !== fromState) tokenEl.value = fromState;
  }

  // Show connection status based on bridge state
  const hasToken = !!(state.token || '').trim();
  
  $('conn').innerHTML = `<span class="dot ${state.connected ? 'on' : 'off'}"></span>${
    state.connected ? 'Connected' : hasToken ? 'Connecting…' : 'No token'
  }`;
  $('status').innerHTML = `<span class="dot ${state.capturing ? 'on' : 'off'}"></span>${
    state.capturing
      ? `Capturing · ${state.allowlist.length} domain${state.allowlist.length === 1 ? '' : 's'} · ${state.attachedTabs} tab${state.attachedTabs === 1 ? '' : 's'}`
      : 'Capture disabled'
  }`;

  const host = await activeTabHost();
  $('active-tab-host').textContent = host ? `Active tab: ${host}` : '';
  const btn = $('capture-tab') as HTMLButtonElement;
  if (state.activeTabSticky) {
    btn.textContent = '■ Stop capturing this tab';
    btn.classList.add('warn');
    btn.classList.remove('secondary');
  } else {
    btn.textContent = '＋ Capture this tab';
    btn.classList.add('secondary');
    btn.classList.remove('warn');
  }
}

function activateTab(name: string) {
  for (const t of document.querySelectorAll('.tab')) {
    t.classList.toggle('active', (t as HTMLElement).dataset.tab === name);
  }
  for (const id of ['main', 'recent', 'remote', 'auth']) {
    const el = $(`tab-${id}`);
    if (el) el.style.display = id === name ? '' : 'none';
  }
}

async function refreshRemote() {
  const rs = await getRemoteState();
  const enabledEl = $('remote-enabled') as HTMLInputElement | null;
  const urlEl = $('remote-url') as HTMLInputElement | null;
  const tokenEl = $('remote-token') as HTMLInputElement | null;
  const statusEl = $('remote-status') as HTMLElement | null;
  if (!enabledEl) return;
  if (document.activeElement !== enabledEl) enabledEl.checked = !!rs.enabled;
  if (urlEl && document.activeElement !== urlEl) {
    const desired = rs.url || 'wss://capture.eemaill.codes/bridge/ws';
    if (urlEl.value !== desired) urlEl.value = desired;
  }
  if (tokenEl && document.activeElement !== tokenEl) {
    if (tokenEl.value !== (rs.token || '')) tokenEl.value = rs.token || '';
  }
  if (statusEl) {
    statusEl.textContent = rs.enabled ? 'Remote ON — streaming to server.' : 'Remote OFF.';
  }
}

async function init() {
  render(await getState());
  refreshRemote();

  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => activateTab((t as HTMLElement).dataset.tab!));
  });

  ($('capture') as HTMLInputElement).addEventListener('change', async (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    await chrome.runtime.sendMessage({ kind: 'popup-set-capture', enabled });
    render(await getState());
  });

  document.querySelectorAll('#scope button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const scope = (btn as HTMLElement).dataset.scope as CaptureScope;
      renderScope(scope);
      await chrome.runtime.sendMessage({ kind: 'popup-set-scope', scope });
      render(await getState());
    });
  });

  $('capture-tab').addEventListener('click', async () => {
    const s = await getState();
    const tabId = await getActiveTabId();
    const kind = s.activeTabSticky ? 'popup-uncapture-tab' : 'popup-capture-tab';
    await chrome.runtime.sendMessage({ kind, tabId });
    render(await getState());
  });

  $('save').addEventListener('click', async () => {
    const text = ($('allowlist') as HTMLTextAreaElement).value;
    const domains = text
      .split(/\r?\n/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    await chrome.runtime.sendMessage({ kind: 'popup-set-allowlist', domains });
    render(await getState());
  });

  $('reload').addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    for (const t of tabs) if (t.id != null) chrome.tabs.reload(t.id);
  });

  $('save-token').addEventListener('click', async () => {
    const token = ($('token') as HTMLInputElement).value.trim();
    await chrome.runtime.sendMessage({ kind: 'popup-set-token', token });
    setTimeout(async () => render(await getState()), 600);
  });

  $('clear-recent').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ kind: 'popup-clear-recent' });
    render(await getState());
  });

  // Remote tab handlers
  const remoteEnabledEl = $('remote-enabled') as HTMLInputElement | null;
  if (remoteEnabledEl) {
    remoteEnabledEl.addEventListener('change', async (e) => {
      const enabled = (e.target as HTMLInputElement).checked;
      await chrome.runtime.sendMessage({ kind: 'popup-set-remote-enabled', enabled });
      refreshRemote();
    });
  }
  const saveRemoteBtn = $('save-remote');
  if (saveRemoteBtn) {
    saveRemoteBtn.addEventListener('click', async () => {
      const url = ($('remote-url') as HTMLInputElement).value.trim();
      const token = ($('remote-token') as HTMLInputElement).value.trim();
      const enabled = ($('remote-enabled') as HTMLInputElement).checked;
      if (url) await chrome.runtime.sendMessage({ kind: 'popup-set-remote-url', url });
      await chrome.runtime.sendMessage({ kind: 'popup-set-remote-token', token });
      await chrome.runtime.sendMessage({ kind: 'popup-set-remote-enabled', enabled });
      const sEl = $('remote-status');
      if (sEl) sEl.textContent = 'Saved. Reconnecting…';
      setTimeout(() => refreshRemote(), 800);
    });
  }

  const refreshRecent = async () => {
    const s = await getState();
    renderRecent(s.recentHosts, s.allowlist);
  };
  refreshRecent();

  setInterval(async () => {
    const s = await getState();
    render(s);
    renderRecent(s.recentHosts, s.allowlist);
    refreshRemote();
  }, 2000);
}

init();
