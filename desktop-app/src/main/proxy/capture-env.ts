// Builds the environment-variable map that makes a CLI / language runtime route
// its HTTP(S) traffic through our local MITM proxy AND trust our CA.
//
// Why a flat superset (no runtime detection): env vars are namespaced per
// runtime and silently ignored when irrelevant — a Node process ignores
// REQUESTS_CA_BUNDLE, a Python process ignores NODE_EXTRA_CA_CERTS, etc. So we
// set every known var at once and each runtime picks up the ones it understands.
// Detecting the runtime is therefore only ever for a UI label, never for
// correctness.

export interface CaptureEnvInput {
  /** e.g. "http://127.0.0.1:8888" */
  proxyUrl: string;
  /** Path to OUR CA cert alone — for ADDITIVE vars (Node merges it in). */
  caCertPath: string;
  /** Path to the COMBINED bundle (our CA + real roots) — for REPLACEMENT vars. */
  caBundlePath: string;
}

/**
 * The full set of env vars to inject. Split into three groups:
 *  - proxy routing (universal; upper+lower case for tools that are picky)
 *  - additive CA trust (NODE_EXTRA_CA_CERTS — merged with the runtime's bundle)
 *  - replacement CA trust (these OVERWRITE the trust store → must use the
 *    combined bundle, never our CA alone)
 */
export function buildCaptureEnv(input: CaptureEnvInput): Record<string, string> {
  const { proxyUrl, caCertPath, caBundlePath } = input;
  // Never proxy loopback — that would loop our own bridge / proxy traffic.
  const noProxy = '127.0.0.1,localhost,::1';

  return {
    // ── Proxy routing (universal). Many tools read UPPER, curl/git read lower. ──
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,

    // ── Node: make the BUILT-IN fetch/undici honor the proxy env vars. ──
    // Critical for modern Node CLIs (Claude Code, Gemini CLI) which use global
    // fetch — undici ignores HTTP(S)_PROXY UNLESS this is set (Node 24+; older
    // Node silently ignores it, which is harmless). Without it those tools slip
    // past the proxy entirely.
    NODE_USE_ENV_PROXY: '1',

    // ── CA trust: ADDITIVE (Node appends this to its built-in roots). ──
    NODE_EXTRA_CA_CERTS: caCertPath,

    // ── CA trust: REPLACEMENT (these overwrite the trust store entirely, so
    //    they MUST point at the combined bundle to keep direct TLS working). ──
    SSL_CERT_FILE: caBundlePath, // OpenSSL, curl, Python, Ruby, many others
    SSL_CERT_DIR: '', // force the file above to be authoritative
    REQUESTS_CA_BUNDLE: caBundlePath, // Python requests
    PIP_CERT: caBundlePath, // pip
    CURL_CA_BUNDLE: caBundlePath, // curl
    GIT_SSL_CAINFO: caBundlePath, // git
    CARGO_HTTP_CAINFO: caBundlePath, // Rust / cargo
    DENO_CERT: caBundlePath, // Deno
    AWS_CA_BUNDLE: caBundlePath, // AWS CLI / SDKs
  };
}

/**
 * Human-friendly runtime label for the UI ONLY — does not affect which vars are
 * set. Best-effort guess from the command's first token.
 */
export function detectRuntimeLabel(command: string): string {
  const first = command.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const base = first.replace(/\.(exe|cmd|bat|ps1)$/i, '').replace(/^.*[\\/]/, '');
  const map: Array<[RegExp, string]> = [
    [/^(claude|gemini|node|npm|npx|pnpm|yarn|bun|deno|tsx|ts-node)$/, 'Node/JS'],
    [/^(python|python3|py|pip|pip3|pipx|poetry|uv|conda)$/, 'Python'],
    [/^(curl|wget)$/, 'curl/wget'],
    [/^git$/, 'git'],
    [/^(go|gofmt)$/, 'Go'],
    [/^(cargo|rustc|rustup)$/, 'Rust'],
    [/^(dotnet|nuget)$/, '.NET'],
    [/^(aws|az|gcloud)$/, 'Cloud CLI'],
    [/^(java|mvn|gradle)$/, 'Java'],
  ];
  for (const [re, label] of map) {
    if (re.test(base)) return label;
  }
  return base || 'command';
}

/**
 * Render the injected env as a copy-paste-ready block for the UI (PowerShell
 * syntax). Empty values are omitted. Used so a user can reproduce the capture
 * environment in their own shell if they prefer.
 */
export function envPreview(env: Record<string, string>): string {
  return Object.entries(env)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `$env:${k} = "${v}"`)
    .join('\n');
}
