export const REMOTE_BRIDGE_WSS = 'wss://capture.eemaill.codes/bridge/ws';
export const REMOTE_BRIDGE_HOST = 'capture.eemaill.codes';
export const REMOTE_TOKEN_KEY = 'remoteBridgeToken';
export const REMOTE_ENABLED_KEY = 'remoteEnabled';
export const REMOTE_BRANCH_KEY = 'remoteBridgeUrl';

export async function getRemoteEnabled(): Promise<boolean> {
  const out = await chrome.storage.local.get(REMOTE_ENABLED_KEY);
  return out[REMOTE_ENABLED_KEY] !== false;
}
export async function setRemoteEnabled(v: boolean): Promise<void> {
  await chrome.storage.local.set({ [REMOTE_ENABLED_KEY]: v });
}
export async function getRemoteBridgeUrl(): Promise<string> {
  const out = await chrome.storage.local.get(REMOTE_BRANCH_KEY);
  const v = out[REMOTE_BRANCH_KEY];
  return typeof v === 'string' && v ? v : REMOTE_BRIDGE_WSS;
}
export async function setRemoteBridgeUrl(u: string): Promise<void> {
  await chrome.storage.local.set({ [REMOTE_BRANCH_KEY]: u.trim() });
}
export async function getRemoteToken(): Promise<string> {
  const out = await chrome.storage.local.get(REMOTE_TOKEN_KEY);
  return typeof out[REMOTE_TOKEN_KEY] === 'string' ? out[REMOTE_TOKEN_KEY] : '';
}
export async function setRemoteToken(t: string): Promise<void> {
  await chrome.storage.local.set({ [REMOTE_TOKEN_KEY]: t.trim() });
}
