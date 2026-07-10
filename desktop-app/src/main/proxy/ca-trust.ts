import { app } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';
import { generateCACertificate } from 'mockttp';

const execFileAsync = promisify(execFile);

// Subject CN of our generated root CA. Used both as the cert subject and as the
// match string when removing it from the Windows store.
const CA_COMMON_NAME = 'HAR Capture Suite Root CA';

export interface CaPair {
  key: string;
  cert: string;
}

function caDir(): string {
  const dir = join(app.getPath('userData'), 'har-suite', 'ca');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function keyPath(): string {
  return join(caDir(), 'ca-key.pem');
}
function certPath(): string {
  return join(caDir(), 'ca-cert.pem');
}
function bundlePath(): string {
  return join(caDir(), 'ca-bundle.pem');
}

/**
 * Load the persisted CA, generating (and saving) a fresh one on first run.
 * The same CA is reused across launches so a user only has to trust it once.
 */
export async function ensureCa(): Promise<CaPair> {
  const kp = keyPath();
  const cp = certPath();
  if (existsSync(kp) && existsSync(cp)) {
    return { key: readFileSync(kp, 'utf8'), cert: readFileSync(cp, 'utf8') };
  }
  const { key, cert } = await generateCACertificate({
    commonName: CA_COMMON_NAME,
    organizationName: 'HAR Capture Suite',
    bits: 2048,
  });
  writeFileSync(kp, key, { mode: 0o600 });
  writeFileSync(cp, cert);
  return { key, cert };
}

export function caCertPath(): string {
  return certPath();
}

/**
 * Build (and cache) a COMBINED CA bundle = our root CA + Node's built-in real
 * roots (`tls.rootCertificates`, the Mozilla set). Replacement-style trust env
 * vars (SSL_CERT_FILE, REQUESTS_CA_BUNDLE, CURL_CA_BUNDLE, …) overwrite the
 * whole trust store, so pointing them at our CA alone would break any direct
 * (NO_PROXY / non-proxied) TLS. This bundle keeps both working: proxied traffic
 * trusts our CA, direct traffic still trusts the real roots.
 *
 * Regenerated whenever our CA cert changes (first line of the bundle holds the
 * CA, so a cheap prefix check detects staleness).
 */
export async function ensureCaBundle(): Promise<string> {
  const { cert } = await ensureCa();
  const bp = bundlePath();
  const ours = cert.trim();
  if (existsSync(bp)) {
    const existing = readFileSync(bp, 'utf8');
    if (existing.startsWith(ours)) return bp;
  }
  // Our CA first (so the prefix check above is stable), then every real root.
  const combined = [ours, ...rootCertificates].join('\n') + '\n';
  writeFileSync(bp, combined);
  return bp;
}

export function caBundlePath(): string {
  return bundlePath();
}

/**
 * Install the CA into the CURRENT USER's Trusted Root store (no admin/UAC).
 * Apps that use the Windows system trust store (most native .exe, .NET, Edge)
 * will then trust certs minted by our proxy. Idempotent — re-adding is a no-op
 * thanks to `-f`.
 */
export async function installCa(): Promise<void> {
  if (process.platform !== 'win32') return;
  await ensureCa();
  await execFileAsync('certutil', ['-addstore', '-user', '-f', 'Root', certPath()]);
}

/** Remove the CA from the current user's Root store. Best-effort, idempotent. */
export async function uninstallCa(): Promise<void> {
  if (process.platform !== 'win32') return;
  try {
    await execFileAsync('certutil', ['-delstore', '-user', 'Root', CA_COMMON_NAME]);
  } catch {
    // Not present / already removed — fine.
  }
}

/**
 * Best-effort check that our CA is present in the user's Root store. Returns
 * false on any error (treat as "not installed").
 */
export async function isCaInstalled(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    const { stdout } = await execFileAsync('certutil', ['-store', '-user', 'Root', CA_COMMON_NAME]);
    return stdout.includes(CA_COMMON_NAME);
  } catch {
    return false;
  }
}
