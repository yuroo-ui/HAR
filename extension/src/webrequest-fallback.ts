/**
 * Lightweight webRequest capture path for environments where chrome.debugger
 * is unavailable/unstable (Chrome Android / Kiwi / Mises).
 * Captures headers + method/url/status; no response body (debugger only).
 */
import { hostMatchesAllowlist, shouldCapture, mapResourceTypeFull, type CaptureScope, type CapturedRequest } from '@har-suite/shared';

type Getters = {
  getScope: () => CaptureScope;
  getAllowlist: () => Promise<string[]>;
  getCaptureEnabled: () => Promise<boolean>;
  isSticky: (tabId: number) => boolean;
  isDebuggerAttached: (tabId: number) => boolean;
};

type Handlers = {
  onRequest: (req: CapturedRequest) => void;
  onUpdate: (id: string, patch: Partial<CapturedRequest>) => void;
};

const TYPE_MAP: Record<string, string> = {
  main_frame: 'Document',
  sub_frame: 'Document',
  xmlhttprequest: 'XHR',
  fetch: 'Fetch',
  websocket: 'WebSocket',
  script: 'Script',
  stylesheet: 'Stylesheet',
  image: 'Image',
  font: 'Font',
  media: 'Media',
  ping: 'Ping',
  other: 'Other',
};

export class WebRequestFallback {
  private enabled = false;
  private inflight = new Map<string, CapturedRequest>();
  private handlers: Handlers;
  private getters: Getters;
  private bound = false;

  constructor(handlers: Handlers, getters: Getters) {
    this.handlers = handlers;
    this.getters = getters;
  }

  start() {
    if (this.bound || !chrome.webRequest) return;
    this.bound = true;
    this.enabled = true;

    chrome.webRequest.onBeforeRequest.addListener(
      (details) => {
        void this.onBeforeRequest(details);
      },
      { urls: ['<all_urls>'] },
      ['requestBody'],
    );

    chrome.webRequest.onSendHeaders.addListener(
      (details) => {
        void this.onSendHeaders(details);
      },
      { urls: ['<all_urls>'] },
      ['requestHeaders', 'extraHeaders'],
    );

    chrome.webRequest.onHeadersReceived.addListener(
      (details) => {
        void this.onHeadersReceived(details);
      },
      { urls: ['<all_urls>'] },
      ['responseHeaders', 'extraHeaders'],
    );

    chrome.webRequest.onCompleted.addListener(
      (details) => {
        void this.onCompleted(details);
      },
      { urls: ['<all_urls>'] },
    );

    chrome.webRequest.onErrorOccurred.addListener(
      (details) => {
        void this.onError(details);
      },
      { urls: ['<all_urls>'] },
    );
  }

  stop() {
    this.enabled = false;
  }

  private key(details: { requestId: string; tabId: number }) {
    return `wr:${details.tabId}:${details.requestId}`;
  }

  private async allowed(details: { tabId: number; url: string; type: string }) {
    if (!this.enabled) return false;
    // Prefer debugger when attached (desktop full fidelity)
    if (details.tabId >= 0 && this.getters.isDebuggerAttached(details.tabId)) return false;
    const enabled = await this.getters.getCaptureEnabled();
    if (!enabled) return false;
    let host = '';
    try {
      host = new URL(details.url).host;
    } catch {
      return false;
    }
    const allowlist = await this.getters.getAllowlist();
    const sticky = details.tabId >= 0 && this.getters.isSticky(details.tabId);
    if (!sticky && allowlist.length > 0 && !hostMatchesAllowlist(host, allowlist)) return false;
    const type = mapResourceTypeFull(TYPE_MAP[details.type] || 'Other');
    if (!shouldCapture(type, this.getters.getScope())) return false;
    return true;
  }

  private async onBeforeRequest(details: chrome.webRequest.WebRequestBodyDetails) {
    if (!(await this.allowed(details))) return;
    const type = mapResourceTypeFull(TYPE_MAP[details.type] || 'Other') as CapturedRequest['type'];
    let host = '';
    try {
      host = new URL(details.url).host;
    } catch {}
    let requestBody: string | undefined;
    try {
      const rb = details.requestBody;
      if (rb?.raw?.[0]?.bytes) {
        requestBody = new TextDecoder().decode(new Uint8Array(rb.raw[0].bytes)).slice(0, 200000);
      } else if (rb?.formData) {
        requestBody = JSON.stringify(rb.formData).slice(0, 200000);
      }
    } catch {}
    const req: CapturedRequest = {
      id: this.key(details),
      tabId: details.tabId,
      source: 'web',
      type,
      method: (details.method || 'GET').toUpperCase(),
      url: details.url,
      host,
      startedAt: Date.now(),
      requestHeaders: [],
      responseHeaders: [],
      requestBody,
      initiator: 'webRequest-fallback',
    } as CapturedRequest;
    this.inflight.set(req.id, req);
    this.handlers.onRequest(req);
  }

  private async onSendHeaders(details: chrome.webRequest.WebRequestHeadersDetails) {
    const id = this.key(details);
    const cur = this.inflight.get(id);
    if (!cur) return;
    const headers = (details.requestHeaders || []).map((h) => ({
      name: h.name,
      value: String(h.value || ''),
    }));
    cur.requestHeaders = headers;
    this.handlers.onUpdate(id, { requestHeaders: headers });
  }

  private async onHeadersReceived(details: chrome.webRequest.WebResponseHeadersDetails) {
    const id = this.key(details);
    const cur = this.inflight.get(id);
    if (!cur) return;
    const headers = (details.responseHeaders || []).map((h) => ({
      name: h.name,
      value: String(h.value || '').slice(0, 2000),
    }));
    const patch = {
      status: details.statusCode,
      responseHeaders: headers,
    };
    Object.assign(cur, patch);
    this.handlers.onUpdate(id, patch);
  }

  private async onCompleted(details: chrome.webRequest.WebResponseCacheDetails) {
    const id = this.key(details);
    const cur = this.inflight.get(id);
    if (!cur) return;
    const patch = {
      status: details.statusCode,
      endedAt: Date.now(),
      duration: Date.now() - (cur.startedAt || Date.now()),
    };
    Object.assign(cur, patch);
    this.handlers.onUpdate(id, patch);
    this.inflight.delete(id);
  }

  private async onError(details: chrome.webRequest.WebResponseErrorDetails) {
    const id = this.key(details);
    const cur = this.inflight.get(id);
    if (!cur) return;
    this.handlers.onUpdate(id, {
      status: 0,
      endedAt: Date.now(),
      error: details.error,
    } as any);
    this.inflight.delete(id);
  }
}
