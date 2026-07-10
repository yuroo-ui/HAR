export const BRIDGE_PORT = 9876;
export const BRIDGE_HOST = '127.0.0.1';
export const PROTOCOL_VERSION = 2;

// Full Chrome DevTools Protocol Network.ResourceType enum. We capture far more
// than XHR/Fetch/WebSocket now — a navigating form POST (e.g. a signup submit)
// is type "Document" and was previously dropped on the floor.
export type ResourceType =
  | 'Document'
  | 'Stylesheet'
  | 'Image'
  | 'Media'
  | 'Font'
  | 'Script'
  | 'TextTrack'
  | 'XHR'
  | 'Fetch'
  | 'Prefetch'
  | 'EventSource'
  | 'WebSocket'
  | 'Manifest'
  | 'SignedExchange'
  | 'Ping'
  | 'CSPViolationReport'
  | 'Preflight'
  | 'FedCM'
  | 'Other';

export const CDP_RESOURCE_TYPES: ReadonlySet<ResourceType> = new Set<ResourceType>([
  'Document',
  'Stylesheet',
  'Image',
  'Media',
  'Font',
  'Script',
  'TextTrack',
  'XHR',
  'Fetch',
  'Prefetch',
  'EventSource',
  'WebSocket',
  'Manifest',
  'SignedExchange',
  'Ping',
  'CSPViolationReport',
  'Preflight',
  'FedCM',
  'Other',
]);

/** Map a raw CDP `type` string to our ResourceType, defaulting unknown to 'Other'. */
export function mapResourceTypeFull(t: string | undefined): ResourceType {
  return CDP_RESOURCE_TYPES.has(t as ResourceType) ? (t as ResourceType) : 'Other';
}

// Capture scope. 'data' keeps the list focused on API/navigation traffic; 'all'
// includes static assets (images, CSS, fonts, scripts) for a complete HAR.
export type CaptureScope = 'data' | 'all';

/** Static-asset types excluded in 'data' scope. Scripts are captured because
 *  they're often important (trackers, analytics, SDK loads) and users want to
 *  inspect them via the preview tab.
 */
export const DATA_DENYLIST: ReadonlySet<ResourceType> = new Set<ResourceType>([
  'Image',
  'Stylesheet',
  'Font',
  'Media',
  'TextTrack',
  'Prefetch',
]);

export function shouldCapture(type: ResourceType, scope: CaptureScope): boolean {
  if (scope === 'all') return true;
  return !DATA_DENYLIST.has(type);
}

/**
 * Filter gate for per-application capture. Determines whether traffic from a
 * given process should be captured based on an allowlist of .exe names.
 *
 * @param exe - Executable name (e.g., "node.exe", "claude.exe")
 * @param allowlist - List of allowed .exe names (case-insensitive, with optional .exe suffix normalization)
 * @param bypassAll - If true, capture everything regardless of allowlist
 * @returns true if traffic should be captured, false if it should be dropped
 *
 * Behavior:
 * - If bypassAll is true → always capture
 * - If allowlist is empty → capture all (default / no filter)
 * - Else → capture only if exe matches (case-insensitive)
 */
export function shouldCaptureApp(
  exe: string | undefined,
  allowlist: string[],
  bypassAll: boolean
): boolean {
  if (bypassAll) return true;
  if (allowlist.length === 0) return true;
  if (!exe) return true; // Unknown process → capture (don't silently drop)

  // Normalize: lowercase both sides, strip .exe suffix for flexible matching
  const normalizedExe = exe.toLowerCase().replace(/\.exe$/, '');
  const normalizedAllowlist = allowlist.map((name) => name.toLowerCase().replace(/\.exe$/, ''));

  return normalizedAllowlist.includes(normalizedExe);
}

/**
 * Unified MITM ingest gate (Bug 3). A single pure predicate that decides whether
 * a request captured via the native-app/CLI MITM proxy should be ingested.
 *
 * It composes the global Capture master-pause with the existing scope and
 * app-filter gates, in priority order:
 *   1. `captureEnabled` — the global toggle acts as a master pause. When OFF,
 *      nothing is ingested regardless of scope or app-filter.
 *   2. `shouldCapture(type, scope)` — capture-scope gate (data/all).
 *   3. `shouldCaptureApp(exe, allowlist, bypass)` — per-application allowlist gate.
 *
 * Extracting this as a pure function makes the gate decision unit-testable
 * without a live proxy or Electron. Additive only — it does not change
 * `shouldCapture` or `shouldCaptureApp`.
 */
export function mitmIngestGate(input: {
  captureEnabled: boolean;
  type: ResourceType;
  scope: CaptureScope;
  exe: string | undefined;
  allowlist: string[];
  bypass: boolean;
}): boolean {
  if (!input.captureEnabled) return false;
  if (!shouldCapture(input.type, input.scope)) return false;
  return shouldCaptureApp(input.exe, input.allowlist, input.bypass);
}

/**
 * Infer a CDP-style ResourceType for traffic captured outside Chrome (the MITM
 * proxy for native .exe apps). Raw HTTP has no CDP `type`, so we reconstruct it
 * from the most reliable signals available, in priority order:
 *   1. `Sec-Fetch-Dest` request header (modern clients send the truest intent)
 *   2. response `Content-Type`
 *   3. URL file extension (last resort)
 * Defaults to 'Other' when nothing matches.
 */
export function inferResourceType(input: {
  secFetchDest?: string;
  contentType?: string;
  upgrade?: string;
  url?: string;
}): ResourceType {
  const upgrade = input.upgrade?.toLowerCase() ?? '';
  if (upgrade.includes('websocket')) return 'WebSocket';

  // 1. Sec-Fetch-Dest — the closest native equivalent to CDP's ResourceType.
  const dest = input.secFetchDest?.toLowerCase().trim();
  if (dest && dest !== 'empty') {
    switch (dest) {
      case 'document':
      case 'iframe':
      case 'frame':
      case 'nested-document':
        return 'Document';
      case 'script':
      case 'serviceworker':
      case 'sharedworker':
      case 'worker':
        return 'Script';
      case 'style':
        return 'Stylesheet';
      case 'image':
        return 'Image';
      case 'font':
        return 'Font';
      case 'audio':
      case 'video':
        return 'Media';
      case 'track':
        return 'TextTrack';
      case 'manifest':
        return 'Manifest';
      case 'report':
        return 'CSPViolationReport';
    }
  }

  // 2. Content-Type of the response.
  const ct = input.contentType?.toLowerCase().split(';')[0].trim() ?? '';
  if (ct) {
    if (ct === 'text/html' || ct === 'application/xhtml+xml') return 'Document';
    if (ct === 'text/css') return 'Stylesheet';
    if (/javascript|ecmascript/.test(ct)) return 'Script';
    if (ct === 'text/event-stream') return 'EventSource';
    if (ct.startsWith('image/')) return 'Image';
    if (ct.startsWith('audio/') || ct.startsWith('video/')) return 'Media';
    if (
      ct.startsWith('font/') ||
      ct.startsWith('application/font') ||
      ct === 'application/vnd.ms-fontobject'
    )
      return 'Font';
    if (ct === 'application/manifest+json' || ct === 'application/x-web-app-manifest+json')
      return 'Manifest';
    if (
      ct === 'application/json' ||
      ct === 'application/xml' ||
      ct === 'text/xml' ||
      ct.endsWith('+json') ||
      ct.endsWith('+xml') ||
      ct.startsWith('application/grpc')
    )
      return 'XHR';
  }

  // 3. URL extension fallback.
  const ext = extOf(input.url);
  if (ext) {
    const byExt = EXT_TYPE[ext];
    if (byExt) return byExt;
  }

  return 'Other';
}

function extOf(url: string | undefined): string {
  if (!url) return '';
  try {
    const path = new URL(url).pathname;
    const dot = path.lastIndexOf('.');
    if (dot < 0 || dot < path.lastIndexOf('/')) return '';
    return path.slice(dot + 1).toLowerCase();
  } catch {
    return '';
  }
}

const EXT_TYPE: Record<string, ResourceType> = {
  html: 'Document',
  htm: 'Document',
  css: 'Stylesheet',
  js: 'Script',
  mjs: 'Script',
  json: 'XHR',
  xml: 'XHR',
  png: 'Image',
  jpg: 'Image',
  jpeg: 'Image',
  gif: 'Image',
  webp: 'Image',
  svg: 'Image',
  ico: 'Image',
  avif: 'Image',
  woff: 'Font',
  woff2: 'Font',
  ttf: 'Font',
  otf: 'Font',
  eot: 'Font',
  mp4: 'Media',
  webm: 'Media',
  mp3: 'Media',
  ogg: 'Media',
  wav: 'Media',
  wasm: 'Other',
};

export interface CapturedHeader {
  name: string;
  value: string;
}

export interface WebSocketMessage {
  direction: 'sent' | 'received';
  timestamp: number;
  opcode: number;
  payload: string;
  payloadLength: number;
}

export interface CapturedRequest {
  id: string;
  tabId: number;
  // Capture origin. 'web' = Chrome extension via CDP (default when omitted);
  // 'app' = native .exe traffic via the desktop MITM proxy. Optional so older
  // rows and imported HARs remain valid without a PROTOCOL_VERSION bump.
  source?: 'web' | 'app';
  // Originating process for app traffic. Only populated for source='app' on Windows.
  // Contains PID and executable name (e.g., "node.exe", "claude.exe"). Used for
  // per-app filtering. Optional so older captures remain valid.
  originProcess?: { pid: number; exe: string };
  type: ResourceType;
  method: string;
  url: string;
  host: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status?: number;
  statusText?: string;
  requestHeaders: CapturedHeader[];
  requestBody?: string;
  responseHeaders: CapturedHeader[];
  responseBody?: string;
  responseMimeType?: string;
  responseSize?: number;
  fromCache?: boolean;
  initiator?: string;
  failed?: boolean;
  errorText?: string;
  wsMessages?: WebSocketMessage[];
}

export type CaptchaType =
  | 'recaptcha-v2'
  | 'recaptcha-v3'
  | 'recaptcha-enterprise'
  | 'hcaptcha'
  | 'turnstile'
  | 'arkose'
  | 'geetest'
  | 'geetest-v4'
  | 'datadome'
  | 'aws-waf'
  | 'unknown';

export interface CaptchaDetection {
  id: string; // stable hash of type+sitekey+pageHost
  type: CaptchaType;
  sitekey: string;
  pageUrl: string;
  pageHost: string;
  sourceUrl: string;
  source: 'network' | 'dom' | 'script';
  detectedAt: number;
  tabId?: number;
  requestId?: string;
  extra?: Record<string, string>;
}

export type BridgeMessage =
  | { kind: 'auth'; token: string; extensionVersion: string; protocol: number }
  | { kind: 'auth-ok' }
  | { kind: 'auth-fail'; reason: string }
  | { kind: 'request'; payload: CapturedRequest }
  | { kind: 'request-update'; id: string; patch: Partial<CapturedRequest> }
  | { kind: 'ws-message'; id: string; message: WebSocketMessage }
  | { kind: 'allowlist-sync'; domains: string[] }
  | { kind: 'set-allowlist'; domains: string[] }
  | { kind: 'set-capture'; enabled: boolean }
  | { kind: 'set-capture-scope'; scope: CaptureScope }
  // `scope` and `attachedTabs` are optional so old desktop/extension builds that
  // predate capture-scope keep working without a PROTOCOL_VERSION bump.
  | {
      kind: 'status';
      capturing: boolean;
      allowlist: string[];
      scope?: CaptureScope;
      attachedTabs?: number;
    }
  | { kind: 'captcha-detected'; payload: CaptchaDetection };

export interface Session {
  id: number;
  name: string;
  createdAt: number;
  closedAt: number | null;
  count: number;
}

export interface RedactionConfig {
  enabled: boolean;
  headerPatterns: string[];
  bodyPatterns: string[];
}

export const DEFAULT_REDACTION: RedactionConfig = {
  enabled: false,
  headerPatterns: [
    'authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'x-auth-token',
    'proxy-authorization',
  ],
  bodyPatterns: ['password', 'secret', 'access_token', 'refresh_token', 'id_token'],
};

export const REDACTED_VALUE = '<redacted>';

export function hostMatchesAllowlist(host: string, allowlist: string[]): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return allowlist.some((d) => {
    if (!d) return false;
    if (d === h) return true;
    return h.endsWith('.' + d);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Bug 4 (capture-bugfixes §4.4) — testable seams for native-app WebSocket
// capture through the MITM proxy. All three are pure/mockttp-free and
// Electron-free so the WS logic can be unit-tested cross-OS. Additive only:
// MitmCapture adopts them internally in Task 5.2 without changing its API.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Bound on the event-id → publicId map, mirroring `MitmCapture` (and the CDP
 * path's own in-flight cap). The oldest entry is evicted once the limit is hit
 * so abandoned/aborted streams can't leak memory forever.
 */
export const INFLIGHT_LIMIT = 4000;

/** Extract the host (`host:port` when present) from a URL; '' when unparseable. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Convert mockttp-style raw header pairs into our `CapturedHeader[]` shape. */
function rawHeadersToList(raw: Array<[string, string]> | undefined): CapturedHeader[] {
  if (!raw) return [];
  return raw.map(([name, value]) => ({ name, value }));
}

/**
 * Bounded `event id → publicId` registry extracted from `MitmCapture` (its
 * `this.ids` map + `rememberId` + `INFLIGHT_LIMIT` eviction). WebSocket frames,
 * responses, and close events all key off the connection's event id (mockttp's
 * `streamId`/response `id` == the `websocket-request` id), so a single lookup
 * maps every downstream event back to the row's publicId.
 *
 * Eviction replicates the original exactly: when the map is at the limit, the
 * oldest entry (insertion order) is dropped before the new one is inserted.
 */
export class IdRegistry {
  private readonly ids = new Map<string, string>();

  constructor(private readonly limit: number = INFLIGHT_LIMIT) {}

  /** Register a connection/event id → namespaced publicId, evicting oldest at the limit. */
  remember(eventId: string, publicId: string): void {
    if (this.ids.size >= this.limit) {
      // Drop the oldest entry (insertion order) to bound memory — matches rememberId.
      const oldest = this.ids.keys().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    this.ids.set(eventId, publicId);
  }

  /** Look up the publicId for a stream/event id; undefined if never registered or evicted. */
  get(streamId: string): string | undefined {
    return this.ids.get(streamId);
  }

  /** Number of currently tracked mappings (introspection / eviction tests). */
  get size(): number {
    return this.ids.size;
  }
}

/** mockttp `timingEvents` subset needed to derive a WS row's start/close timing. */
export interface WsTimingEvents {
  startTime?: number;
  startTimestamp?: number;
  wsClosedTimestamp?: number;
}

/** Minimal, mockttp-free shape of a WebSocket upgrade request used to build a row. */
export interface WsRowInput {
  id: string;
  url: string;
  method: string;
  hostname?: string;
  rawHeaders?: Array<[string, string]>;
  timingEvents?: WsTimingEvents;
}

/**
 * Build a `CapturedRequest` of type `'WebSocket'` for an app WS upgrade, matching
 * the browser/CDP row shape (`extension/src/debugger.ts` `onWebSocketCreated`):
 * `method: 'GET'`, empty `responseHeaders`, and `wsMessages: []` initialized.
 * The MITM path additionally carries real `requestHeaders` (from `rawHeaders`)
 * and marks `source: 'app'`; process attribution is layered on by the caller.
 */
export function buildWsRow(req: WsRowInput, publicId: string): CapturedRequest {
  return {
    id: publicId,
    tabId: -1,
    source: 'app',
    type: 'WebSocket',
    method: req.method,
    url: req.url,
    host: hostOf(req.url) || req.hostname || '',
    startedAt: req.timingEvents?.startTime ?? Date.now(),
    requestHeaders: rawHeadersToList(req.rawHeaders),
    responseHeaders: [],
    initiator: 'app',
    wsMessages: [],
  };
}

/**
 * Compute a WS connection's close timing, mirroring `onResponse`'s arithmetic:
 * `endedAt` is wall-clock (`startTime + (wsClosedTimestamp - startTimestamp)`)
 * when all timestamps are present, else `Date.now()`; `durationMs` is the
 * clamped monotonic span (`max(0, wsClosedTimestamp - startTimestamp)`) when
 * both endpoints are present, else undefined.
 */
export function wsCloseTiming(t: WsTimingEvents): { endedAt: number; durationMs?: number } {
  const endedAt =
    t.startTime != null && t.startTimestamp != null && t.wsClosedTimestamp != null
      ? t.startTime + (t.wsClosedTimestamp - t.startTimestamp)
      : Date.now();
  const durationMs =
    t.startTimestamp != null && t.wsClosedTimestamp != null
      ? Math.max(0, t.wsClosedTimestamp - t.startTimestamp)
      : undefined;
  return { endedAt, durationMs };
}

// Re-export captcha detector for use by both the extension and the desktop app.
export { detectFromUrl, stableId } from './captcha-detector';
export type { DetectionInput } from './captcha-detector';
