import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const execFileAsync = promisify(execFile);
const nodeRequire = createRequire(__filename);

const ENV_KEY = 'HKCU\\Environment';

/**
 * Snapshot of the user-environment values we overwrite, so we can restore them
 * exactly. `null` means the variable did NOT exist before (so restore = delete,
 * not set-to-empty).
 */
export type EnvSnapshot = Record<string, string | null>;

/**
 * Broadcast WM_SETTINGCHANGE("Environment") so newly-launched shells/processes
 * pick up the changed user environment. (Already-running processes keep their
 * inherited env — that's a Windows fact, surfaced in the UI.) Non-fatal on
 * failure: the registry is still updated, new shells just need a moment.
 */
function broadcastEnvChange(): void {
  if (process.platform !== 'win32') return;
  try {
    const koffi = nodeRequire('koffi');
    const user32 = koffi.load('user32.dll');
    // LRESULT SendMessageTimeoutW(HWND, UINT, WPARAM, LPCWSTR, UINT, UINT, PDWORD)
    // HWND is passed as a uintptr so we can give it the literal HWND_BROADCAST
    // (0xffff) without constructing a pointer object.
    const SendMessageTimeout = user32.func('__stdcall', 'SendMessageTimeoutW', 'long', [
      'uintptr', // hWnd
      'uint32', // Msg
      'uintptr', // wParam
      'str16', // lParam (the string "Environment")
      'uint32', // fuFlags
      'uint32', // uTimeout
      'void *', // lpdwResult
    ]);
    const HWND_BROADCAST = 0xffff;
    const WM_SETTINGCHANGE = 0x001a;
    const SMTO_ABORTIFHUNG = 0x0002;
    SendMessageTimeout(
      HWND_BROADCAST,
      WM_SETTINGCHANGE,
      0,
      'Environment',
      SMTO_ABORTIFHUNG,
      2000,
      null,
    );
  } catch (e) {
    console.warn('[global-env] broadcast failed (non-fatal)', e);
  }
}

async function readEnvVar(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('reg', ['query', ENV_KEY, '/v', name]);
    // "    HTTPS_PROXY    REG_SZ    http://127.0.0.1:8888"
    const m = stdout.match(new RegExp('^\\s*' + name + '\\s+REG_(?:EXPAND_)?SZ\\s+(.*)$', 'im'));
    return m ? m[1].trim() : null;
  } catch {
    return null; // not present
  }
}

async function setEnvVar(name: string, value: string): Promise<void> {
  await execFileAsync('reg', ['add', ENV_KEY, '/v', name, '/t', 'REG_SZ', '/d', value, '/f']);
}

async function deleteEnvVar(name: string): Promise<void> {
  try {
    await execFileAsync('reg', ['delete', ENV_KEY, '/v', name, '/f']);
  } catch {
    // Wasn't there — fine.
  }
}

/**
 * Write our capture env vars into the persistent user environment and return a
 * snapshot of the PREVIOUS values so the caller can persist + later restore.
 * Empty-string values are skipped (a blank persistent var is meaningless and
 * would just clutter the user's environment).
 */
export async function enableGlobalEnv(envMap: Record<string, string>): Promise<EnvSnapshot> {
  const snapshot: EnvSnapshot = {};
  if (process.platform !== 'win32') return snapshot;
  for (const [name, value] of Object.entries(envMap)) {
    if (value === '') continue;
    snapshot[name] = await readEnvVar(name);
    await setEnvVar(name, value);
  }
  broadcastEnvChange();
  return snapshot;
}

/** Restore a previously-captured environment snapshot exactly. Idempotent. */
export async function restoreGlobalEnv(snapshot: EnvSnapshot): Promise<void> {
  if (process.platform !== 'win32') return;
  for (const [name, prev] of Object.entries(snapshot)) {
    if (prev === null) await deleteEnvVar(name);
    else await setEnvVar(name, prev);
  }
  broadcastEnvChange();
}

/**
 * Synchronous restore for the app-quit path, where async work may not finish
 * before the process exits. Best-effort — swallows errors.
 */
export function restoreGlobalEnvSync(snapshot: EnvSnapshot): void {
  if (process.platform !== 'win32') return;
  const run = (args: string[]) => {
    try {
      execFileSync('reg', args, { stdio: 'ignore' });
    } catch {
      /* best-effort */
    }
  };
  for (const [name, prev] of Object.entries(snapshot)) {
    if (prev === null) run(['delete', ENV_KEY, '/v', name, '/f']);
    else run(['add', ENV_KEY, '/v', name, '/t', 'REG_SZ', '/d', prev, '/f']);
  }
  broadcastEnvChange();
}
