export { hostMatchesAllowlist } from '@har-suite/shared';
import type { CaptureScope } from '@har-suite/shared';

const ALLOWLIST_KEY = 'allowlist';
const CAPTURE_ENABLED_KEY = 'captureEnabled';
const CAPTURE_SCOPE_KEY = 'captureScope';
const TOKEN_KEY = 'bridgeToken';
const RECENT_HOSTS_KEY = 'recentHosts';
const STICKY_TABS_KEY = 'stickyTabs';
const RECENT_LIMIT = 30;

export async function getAllowlist(): Promise<string[]> {
  const out = await chrome.storage.local.get(ALLOWLIST_KEY);
  const v = out[ALLOWLIST_KEY];
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

export async function setAllowlist(domains: string[]): Promise<void> {
  const clean = Array.from(new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean)));
  await chrome.storage.local.set({ [ALLOWLIST_KEY]: clean });
}

export async function getCaptureEnabled(): Promise<boolean> {
  const out = await chrome.storage.local.get(CAPTURE_ENABLED_KEY);
  return out[CAPTURE_ENABLED_KEY] !== false;
}

export async function setCaptureEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [CAPTURE_ENABLED_KEY]: enabled });
}

export async function getCaptureScope(): Promise<CaptureScope> {
  const out = await chrome.storage.local.get(CAPTURE_SCOPE_KEY);
  return out[CAPTURE_SCOPE_KEY] === 'all' ? 'all' : 'data';
}

export async function setCaptureScope(scope: CaptureScope): Promise<void> {
  await chrome.storage.local.set({ [CAPTURE_SCOPE_KEY]: scope === 'all' ? 'all' : 'data' });
}

// Sticky tabs persist to chrome.storage.session so an MV3 service-worker eviction
// mid-flow doesn't silently stop capturing. session storage clears on browser close.
export async function getStickyTabs(): Promise<number[]> {
  try {
    const out = await chrome.storage.session.get(STICKY_TABS_KEY);
    const v = out[STICKY_TABS_KEY];
    return Array.isArray(v) ? v.filter((x) => typeof x === 'number') : [];
  } catch {
    return [];
  }
}

export async function setStickyTabs(tabIds: number[]): Promise<void> {
  try {
    await chrome.storage.session.set({ [STICKY_TABS_KEY]: tabIds });
  } catch {
    // storage.session unavailable (very old Chrome) — sticky set stays in-memory only.
  }
}

export async function getToken(): Promise<string> {
  const out = await chrome.storage.local.get(TOKEN_KEY);
  return typeof out[TOKEN_KEY] === 'string' ? out[TOKEN_KEY] : '';
}

export async function setToken(token: string): Promise<void> {
  await chrome.storage.local.set({ [TOKEN_KEY]: token.trim() });
}

export async function getRecentHosts(): Promise<{ host: string; count: number; last: number }[]> {
  const out = await chrome.storage.local.get(RECENT_HOSTS_KEY);
  const v = out[RECENT_HOSTS_KEY];
  return Array.isArray(v) ? v : [];
}

export async function recordHost(host: string): Promise<void> {
  if (!host) return;
  const list = await getRecentHosts();
  const now = Date.now();
  const idx = list.findIndex((e) => e.host === host);
  if (idx >= 0) {
    list[idx].count += 1;
    list[idx].last = now;
  } else {
    list.push({ host, count: 1, last: now });
  }
  list.sort((a, b) => b.last - a.last);
  await chrome.storage.local.set({ [RECENT_HOSTS_KEY]: list.slice(0, RECENT_LIMIT) });
}

export async function clearRecentHosts(): Promise<void> {
  await chrome.storage.local.set({ [RECENT_HOSTS_KEY]: [] });
}
