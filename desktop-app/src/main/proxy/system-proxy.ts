import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const execFileAsync = promisify(execFile);
const nodeRequire = createRequire(__filename);

const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** Snapshot of the user's proxy settings so we can restore them exactly. */
export interface ProxySnapshot {
  proxyEnable: number; // 0 | 1
  proxyServer: string; // '' when unset
  proxyOverride: string; // '' when unset
}

/**
 * Tell WinINet that proxy settings changed so running apps re-read the registry
 * immediately (without this, the change is silently cached until next launch).
 * Uses koffi to call InternetSetOption(NULL, ...). Failure is non-fatal — the
 * registry is still updated; some apps just won't pick it up until restart.
 */
function refreshWinInet(): void {
  if (process.platform !== 'win32') return;
  try {
    // Lazy require so non-Windows / test environments never load the native lib.
    const koffi = nodeRequire('koffi');
    const wininet = koffi.load('wininet.dll');
    // BOOL InternetSetOptionW(HINTERNET, DWORD dwOption, LPVOID, DWORD);
    const InternetSetOption = wininet.func('__stdcall', 'InternetSetOptionW', 'bool', [
      'void *',
      'uint32',
      'void *',
      'uint32',
    ]);
    const INTERNET_OPTION_SETTINGS_CHANGED = 39;
    const INTERNET_OPTION_REFRESH = 37;
    InternetSetOption(null, INTERNET_OPTION_SETTINGS_CHANGED, null, 0);
    InternetSetOption(null, INTERNET_OPTION_REFRESH, null, 0);
  } catch (e) {
    console.warn('[system-proxy] WinINet refresh failed (non-fatal)', e);
  }
}

async function regQuery(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('reg', ['query', REG_PATH, '/v', name]);
    // Output line looks like: "    ProxyEnable    REG_DWORD    0x1"
    const m = stdout.match(new RegExp(name + '\\s+REG_\\w+\\s+(.+)', 'i'));
    return m ? m[1].trim() : null;
  } catch {
    return null; // value not present
  }
}

/** Read the current proxy settings into a snapshot. */
export async function readProxy(): Promise<ProxySnapshot> {
  const enableRaw = await regQuery('ProxyEnable');
  const server = await regQuery('ProxyServer');
  const override = await regQuery('ProxyOverride');
  const proxyEnable = enableRaw ? parseInt(enableRaw, 16) || (enableRaw === '0x1' ? 1 : 0) : 0;
  return {
    proxyEnable: proxyEnable === 1 ? 1 : 0,
    proxyServer: server ?? '',
    proxyOverride: override ?? '',
  };
}

async function regSetDword(name: string, value: number): Promise<void> {
  await execFileAsync('reg', [
    'add',
    REG_PATH,
    '/v',
    name,
    '/t',
    'REG_DWORD',
    '/d',
    String(value),
    '/f',
  ]);
}

async function regSetString(name: string, value: string): Promise<void> {
  if (value === '') {
    // Empty string: delete the value to truly restore "unset" state.
    try {
      await execFileAsync('reg', ['delete', REG_PATH, '/v', name, '/f']);
    } catch {
      // Wasn't there — fine.
    }
    return;
  }
  await execFileAsync('reg', ['add', REG_PATH, '/v', name, '/t', 'REG_SZ', '/d', value, '/f']);
}

/**
 * Point the Windows system proxy at our local MITM proxy. Returns the PREVIOUS
 * settings so the caller can persist and later restore them.
 */
export async function enableProxy(port: number): Promise<ProxySnapshot> {
  const previous = await readProxy();
  if (process.platform !== 'win32') return previous;
  await regSetString('ProxyServer', `127.0.0.1:${port}`);
  // Bypass local addresses so the app's own loopback/bridge traffic isn't proxied.
  await regSetString('ProxyOverride', '<local>');
  await regSetDword('ProxyEnable', 1);
  refreshWinInet();
  return previous;
}

/** Restore a previously-captured proxy snapshot exactly. Idempotent. */
export async function restoreProxy(snapshot: ProxySnapshot): Promise<void> {
  if (process.platform !== 'win32') return;
  await regSetString('ProxyServer', snapshot.proxyServer);
  await regSetString('ProxyOverride', snapshot.proxyOverride);
  await regSetDword('ProxyEnable', snapshot.proxyEnable);
  refreshWinInet();
}

/**
 * Synchronous restore for the app-quit path, where async work may not finish
 * before the process exits. Blocks on `reg.exe`. Best-effort — swallows errors.
 */
export function restoreProxySync(snapshot: ProxySnapshot): void {
  if (process.platform !== 'win32') return;
  const run = (args: string[]) => {
    try {
      execFileSync('reg', args, { stdio: 'ignore' });
    } catch {
      /* best-effort */
    }
  };
  if (snapshot.proxyServer === '') run(['delete', REG_PATH, '/v', 'ProxyServer', '/f']);
  else
    run(['add', REG_PATH, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', snapshot.proxyServer, '/f']);
  if (snapshot.proxyOverride === '') run(['delete', REG_PATH, '/v', 'ProxyOverride', '/f']);
  else
    run([
      'add',
      REG_PATH,
      '/v',
      'ProxyOverride',
      '/t',
      'REG_SZ',
      '/d',
      snapshot.proxyOverride,
      '/f',
    ]);
  run([
    'add',
    REG_PATH,
    '/v',
    'ProxyEnable',
    '/t',
    'REG_DWORD',
    '/d',
    String(snapshot.proxyEnable),
    '/f',
  ]);
  refreshWinInet();
}
