/**
 * Resolves a client-side ephemeral port (the port a local app used to connect
 * to our MITM proxy) to the originating process PID + .exe name.
 *
 * Uses Windows TCP_TABLE_OWNER_PID_CONNECTIONS via koffi FFI on iphlpapi.dll.
 * Each row is 24 bytes: dwState(4) dwLocalAddr(4) dwLocalPort(4, BE) dwRemoteAddr(4)
 * dwRemotePort(4) dwOwningPid(4). We match on local port (the client's side).
 *
 * Only loaded on Windows (lazy require). Returns null on non-Windows.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(__filename);

interface ProcessInfo {
  pid: number;
  exe: string;
}

// Cache PID→exe for the session to avoid repeated tasklist calls (~130ms each).
const exeCache = new Map<number, string>();

// koffi + iphlpapi loaded lazily on first use (Windows only).
let iphlpapi: any = null;
let GetExtendedTcpTable: any = null;

function initKoffi(): void {
  if (iphlpapi) return;
  try {
    const koffi = nodeRequire('koffi');
    iphlpapi = koffi.load('iphlpapi.dll');
    // The size out-param MUST be declared inout, otherwise the updated size is
    // never read back and the call returns ERROR_INSUFFICIENT_BUFFER forever.
    GetExtendedTcpTable = iphlpapi.func('__stdcall', 'GetExtendedTcpTable', 'uint32', [
      'void *',
      koffi.inout('uint32 *'),
      'bool',
      'uint32', // ulAf: AF_INET = 2
      'int', // tableClass: TCP_TABLE_OWNER_PID_CONNECTIONS = 5
      'uint32', // reserved
    ]);
  } catch (e) {
    console.warn('[process-resolver] koffi/iphlpapi init failed (non-Windows?)', e);
  }
}

/**
 * Look up the process owning the given local port via the Windows TCP table.
 * Returns null if not found (short-lived connection, non-Windows, or lookup failure).
 */
function lookupByPort(port: number): ProcessInfo | null {
  if (process.platform !== 'win32') return null;
  initKoffi();
  if (!GetExtendedTcpTable) return null;

  // First call: get required buffer size.
  let size = [0];
  const rc1 = GetExtendedTcpTable(null, size, false, 2, 5, 0);
  if (rc1 !== 122) {
    // 122 = ERROR_INSUFFICIENT_BUFFER (expected). Anything else is a real error.
    console.warn('[process-resolver] GetExtendedTcpTable size probe failed:', rc1);
    return null;
  }

  // Second call: fetch the table.
  const buf = Buffer.alloc(size[0]);
  size = [buf.length];
  const rc2 = GetExtendedTcpTable(buf, size, false, 2, 5, 0);
  if (rc2 !== 0) {
    console.warn('[process-resolver] GetExtendedTcpTable fetch failed:', rc2);
    return null;
  }

  const numEntries = buf.readUInt32LE(0);
  for (let i = 0; i < numEntries; i++) {
    const offset = 4 + i * 24;
    const localPort = buf.readUInt16BE(offset + 8); // network byte order (big-endian)
    const pid = buf.readUInt32LE(offset + 20);
    if (localPort === port) {
      return { pid, exe: '(pending)' };
    }
  }
  return null;
}

/**
 * Resolve PID → process name (e.g., "node.exe") via tasklist. Cached per-PID.
 * Returns '(unknown)' on failure.
 */
function resolveExeName(pid: number): string {
  if (exeCache.has(pid)) return exeCache.get(pid)!;
  if (process.platform !== 'win32') return '(non-Windows)';

  try {
    const output = execFileSync(
      'tasklist',
      ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'],
      { encoding: 'utf8', timeout: 2000 }
    );
    // Parse: "Name.exe","PID","Session Name",...
    const match = output.match(/^"([^"]+)"/);
    const exe = match ? match[1] : '(unknown)';
    exeCache.set(pid, exe);
    return exe;
  } catch (e) {
    const fallback = '(unknown)';
    exeCache.set(pid, fallback);
    return fallback;
  }
}

/**
 * Public API: given a client-side port, return the originating process info.
 * Returns null if the port is not found (connection already closed, non-Windows, etc.).
 */
export function lookupProcess(port: number | undefined): ProcessInfo | null {
  if (port == null) return null;
  const info = lookupByPort(port);
  if (!info) return null;
  return { pid: info.pid, exe: resolveExeName(info.pid) };
}

/**
 * Get all running process names on Windows
 */
export function getRunningProcesses(): string[] {
  if (process.platform !== 'win32') {
    return [];
  }

  try {
    // Use tasklist to get all processes, parse CSV output
    const output = execFileSync('tasklist', ['/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      timeout: 2000
    });
    const processes = new Set<string>();

    output.split('\n').forEach(line => {
      const match = line.match(/^"([^"]+)"/);
      if (match) {
        processes.add(match[1]);
      }
    });

    return Array.from(processes).sort();
  } catch (error) {
    console.warn('[process-resolver] Failed to get running processes:', error);
    return [];
  }
}

/**
 * Clear the exe cache (e.g., on session reset or after a long idle period).
 */
export function clearProcessCache(): void {
  exeCache.clear();
}
