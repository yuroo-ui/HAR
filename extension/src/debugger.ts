import {
  mapResourceTypeFull,
  shouldCapture,
  type CaptureScope,
  type CapturedHeader,
  type CapturedRequest,
  type ResourceType,
  type WebSocketMessage,
} from '@har-suite/shared';

const DEBUGGER_PROTOCOL = '1.3';

// Pause freshly-attached OOPIF/worker targets until we've enabled Network on
// them — this guarantees we don't miss a child's earliest requests (the ones
// that often carry a reCAPTCHA sitekey). The trade-off is that the target stays
// frozen until we call Runtime.runIfWaitingForDebugger, so the resume MUST always
// fire (see the `finally` in onAttachedToTarget). If paused-iframe hangs are ever
// observed (e.g. under MV3 service-worker eviction), flip this to `false`.
const WAIT_FOR_DEBUGGER = true;

// Which child target types to auto-attach into. "iframe" here means out-of-process
// (cross-origin) iframes — same-process frames already flow on the parent session.
const CHILD_FILTER = [
  { type: 'iframe' },
  { type: 'worker' },
  { type: 'shared_worker' },
  { type: 'service_worker' },
];

// Cap on concurrently in-flight requests we track. Top-frame navigations abandon
// in-flight root requests (no loadingFinished fires), so without a bound the map
// slowly leaks. 2000 is generous for any real page.
const INFLIGHT_LIMIT = 2000;

type Listener = {
  onRequest: (req: CapturedRequest) => void;
  onUpdate: (id: string, patch: Partial<CapturedRequest>) => void;
  onWsMessage: (id: string, msg: WebSocketMessage) => void;
  /** Fires for every request URL regardless of resource type — used for captcha detection. */
  onCaptchaUrl?: (url: string, tabId: number, requestId: string, requestBody?: string) => void;
};

/** A flat-session target descriptor accepted by chrome.debugger.sendCommand (Chrome 125+). */
type SessionTarget = chrome.debugger.Debuggee & { sessionId?: string };

interface SessionInfo {
  sessionId: string;
  tabId: number;
  target: SessionTarget;
  targetType: string;
}

interface InFlight {
  /** Public, namespaced id (`${sessionId}:${requestId}`) so cross-session ids never collide. */
  id: string;
  /** Map key — same as `id`. */
  key: string;
  tabId: number;
  /** Exact session to address Network.getResponseBody to. */
  sessionTarget: SessionTarget;
  type: ResourceType;
  method: string;
  url: string;
  host: string;
  startedAt: number;
  requestHeaders: CapturedHeader[];
  requestBody?: string;
  initiator?: string;
}

function headersToList(headers: Record<string, string> | undefined): CapturedHeader[] {
  if (!headers) return [];
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

function parseHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export class DebuggerCapture {
  private attachedTabs = new Set<number>();
  // sessionId -> child session info. Root sessions have no sessionId and are
  // represented by tabId only (not stored here).
  private sessions = new Map<string, SessionInfo>();
  // tabId -> set of child sessionIds, for O(1) teardown when a tab detaches.
  private tabSessions = new Map<number, Set<string>>();
  private inFlight = new Map<string, InFlight>();
  private listener: Listener;
  private getScope: () => CaptureScope;

  constructor(listener: Listener, getScope: () => CaptureScope) {
    this.listener = listener;
    this.getScope = getScope;
    chrome.debugger.onEvent.addListener(this.handleEvent);
    chrome.debugger.onDetach.addListener(this.handleDetach);
  }

  async attach(tabId: number): Promise<void> {
    if (this.attachedTabs.has(tabId)) return;
    try {
      await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL);
      // Mark attached before awaiting enable so a racing detach can find it.
      this.attachedTabs.add(tabId);
      this.tabSessions.set(tabId, new Set());
      await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
        maxResourceBufferSize: 10 * 1024 * 1024,
        maxTotalBufferSize: 50 * 1024 * 1024,
      });
      // Flatten OOPIFs + workers into child sessions so their network traffic
      // (captcha endpoints, cross-origin flows) is visible to us.
      await chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: WAIT_FOR_DEBUGGER,
        flatten: true,
        filter: CHILD_FILTER,
      });
      console.log('[debugger] attached', tabId);
    } catch (e) {
      console.warn('[debugger] attach failed', tabId, e);
      this.attachedTabs.delete(tabId);
      this.tabSessions.delete(tabId);
    }
  }

  async detach(tabId: number): Promise<void> {
    if (!this.attachedTabs.has(tabId)) return;
    try {
      await chrome.debugger.detach({ tabId });
    } catch (e) {
      console.warn('[debugger] detach failed', tabId, e);
    }
    this.cleanupTab(tabId);
  }

  async detachAll(): Promise<void> {
    const ids = Array.from(this.attachedTabs);
    for (const id of ids) await this.detach(id);
  }

  isAttached(tabId: number): boolean {
    return this.attachedTabs.has(tabId);
  }

  attachedCount(): number {
    return this.attachedTabs.size;
  }

  // ───────────────────── child-target lifecycle ─────────────────────

  private async onAttachedToTarget(source: SessionTarget, p: any): Promise<void> {
    const sessionId: string = p.sessionId;
    const info = p.targetInfo;
    const waiting: boolean = !!p.waitingForDebugger;
    const childTarget: SessionTarget = { sessionId };

    // Resolve the owning tab: source.tabId for a direct child of the root, else the
    // parent child-session's tabId (nested iframe-in-iframe / worker-in-iframe).
    const parentTabId =
      source.tabId ?? (source.sessionId ? this.sessions.get(source.sessionId)?.tabId : undefined);

    if (parentTabId == null) {
      // Unattributable — still MUST resume so the target doesn't hang.
      await this.safeResume(childTarget, waiting);
      return;
    }

    // Idempotency: attachedToTarget can fire twice for the same target on fast nav.
    if (this.sessions.has(sessionId)) {
      await this.safeResume(childTarget, waiting);
      return;
    }

    this.sessions.set(sessionId, {
      sessionId,
      tabId: parentTabId,
      target: childTarget,
      targetType: info?.type ?? 'other',
    });
    this.tabSessions.get(parentTabId)?.add(sessionId);

    try {
      await chrome.debugger.sendCommand(childTarget, 'Network.enable', {});
      // Auto-attach is NOT recursive — re-arm on the child so nested OOPIFs/workers
      // (e.g. the reCAPTCHA challenge bframe inside the anchor iframe) attach too.
      await chrome.debugger.sendCommand(childTarget, 'Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: WAIT_FOR_DEBUGGER,
        flatten: true,
        filter: CHILD_FILTER,
      });
    } catch (e) {
      console.warn('[debugger] child setup failed', sessionId, e);
    } finally {
      // Always release the paused target, even if the setup above threw.
      await this.safeResume(childTarget, waiting);
    }
  }

  private async safeResume(target: SessionTarget, waiting: boolean): Promise<void> {
    if (!waiting) return;
    try {
      await chrome.debugger.sendCommand(target, 'Runtime.runIfWaitingForDebugger', {});
    } catch {
      // Target may already be gone (navigated/closed) — nothing to resume.
    }
  }

  private onDetachedFromTarget(p: any): void {
    const sessionId: string = p.sessionId;
    const info = this.sessions.get(sessionId);
    if (!info) return;
    this.sessions.delete(sessionId);
    this.tabSessions.get(info.tabId)?.delete(sessionId);
    this.dropInFlightForSession(sessionId);
  }

  private cleanupTab(tabId: number): void {
    this.attachedTabs.delete(tabId);
    const sids = this.tabSessions.get(tabId);
    if (sids) {
      for (const sid of sids) {
        this.sessions.delete(sid);
        this.dropInFlightForSession(sid);
      }
    }
    this.tabSessions.delete(tabId);
    // Drop root-session in-flight (key prefix `:`) for this tab.
    for (const [k, f] of this.inFlight) {
      if (f.tabId === tabId && k.startsWith(':')) this.inFlight.delete(k);
    }
  }

  private dropInFlightForSession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const k of this.inFlight.keys()) if (k.startsWith(prefix)) this.inFlight.delete(k);
  }

  // ───────────────────── event routing ─────────────────────

  private handleDetach = (source: chrome.debugger.Debuggee, reason: string) => {
    // onDetach source is a plain Debuggee (tabId) with no sessionId — root teardown.
    if (source.tabId != null) {
      this.cleanupTab(source.tabId);
      console.log('[debugger] detached', source.tabId, reason);
    }
  };

  private handleEvent = (source: SessionTarget, method: string, params?: any) => {
    // Target lifecycle events are delivered on the PARENT session (root or a child),
    // so dispatch them BEFORE any tabId guard.
    if (method === 'Target.attachedToTarget') {
      void this.onAttachedToTarget(source, params);
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      this.onDetachedFromTarget(params);
      return;
    }

    const sessionId = source.sessionId;
    let tabId: number | undefined;
    let sessionTarget: SessionTarget;
    if (sessionId) {
      const info = this.sessions.get(sessionId);
      if (!info) return; // event for an unknown/torn-down child — ignore
      tabId = info.tabId;
      sessionTarget = info.target;
    } else {
      if (source.tabId == null) return;
      tabId = source.tabId;
      sessionTarget = { tabId: source.tabId };
    }

    switch (method) {
      case 'Network.requestWillBeSent':
        this.onRequestWillBeSent(tabId, sessionId, sessionTarget, params);
        break;
      case 'Network.responseReceived':
        this.onResponseReceived(sessionId, params);
        break;
      case 'Network.loadingFinished':
        void this.onLoadingFinished(sessionId, params);
        break;
      case 'Network.loadingFailed':
        this.onLoadingFailed(sessionId, params);
        break;
      case 'Network.webSocketCreated':
        this.onWebSocketCreated(tabId, sessionId, sessionTarget, params);
        break;
      case 'Network.webSocketFrameSent':
        this.onWebSocketFrame(sessionId, params, 'sent');
        break;
      case 'Network.webSocketFrameReceived':
        this.onWebSocketFrame(sessionId, params, 'received');
        break;
      case 'Network.webSocketClosed':
        this.onWebSocketClosed(sessionId, params);
        break;
    }
  };

  private keyFor(sessionId: string | undefined, requestId: string): string {
    return `${sessionId ?? ''}:${requestId}`;
  }

  private trackInFlight(f: InFlight): void {
    this.inFlight.set(f.key, f);
    if (this.inFlight.size > INFLIGHT_LIMIT) {
      const oldest = this.inFlight.keys().next().value;
      if (oldest) this.inFlight.delete(oldest);
    }
  }

  private onRequestWillBeSent(
    tabId: number,
    sessionId: string | undefined,
    target: SessionTarget,
    p: any,
  ): void {
    const reqId = p.requestId as string;
    // Captcha hook runs UNFILTERED for every type (Document/Script/etc.) so iframe
    // captcha script + endpoint loads are detected regardless of capture scope.
    try {
      this.listener.onCaptchaUrl?.(
        p.request.url,
        tabId,
        reqId,
        typeof p.request.postData === 'string' ? p.request.postData : undefined,
      );
    } catch {}

    const rt = mapResourceTypeFull(p.type);
    if (!shouldCapture(rt, this.getScope())) return;

    const key = this.keyFor(sessionId, reqId);

    // Redirects re-emit requestWillBeSent with the SAME requestId and a
    // redirectResponse — surface the hop's status on the existing row.
    if (p.redirectResponse) {
      const existing = this.inFlight.get(key);
      if (existing) {
        this.listener.onUpdate(existing.id, {
          status: p.redirectResponse.status,
          statusText: p.redirectResponse.statusText,
        });
      }
    }

    const startedAt = (p.wallTime ?? Date.now() / 1000) * 1000;
    const id = key;
    const inflight: InFlight = {
      id,
      key,
      tabId,
      sessionTarget: target,
      type: rt,
      method: p.request.method,
      url: p.request.url,
      host: parseHost(p.request.url),
      startedAt,
      requestHeaders: headersToList(p.request.headers),
      requestBody: typeof p.request.postData === 'string' ? p.request.postData : undefined,
      initiator: p.initiator?.type,
    };
    this.trackInFlight(inflight);
    this.listener.onRequest({
      id,
      tabId,
      type: rt,
      method: inflight.method,
      url: inflight.url,
      host: inflight.host,
      startedAt,
      requestHeaders: inflight.requestHeaders,
      requestBody: inflight.requestBody,
      responseHeaders: [],
      initiator: inflight.initiator,
    });
  }

  private onResponseReceived(sessionId: string | undefined, p: any): void {
    const f = this.inFlight.get(this.keyFor(sessionId, p.requestId));
    if (!f) return;
    const r = p.response;
    this.listener.onUpdate(f.id, {
      status: r.status,
      statusText: r.statusText,
      responseHeaders: headersToList(r.headers),
      responseMimeType: r.mimeType,
      fromCache: !!r.fromDiskCache,
    });
  }

  private async onLoadingFinished(sessionId: string | undefined, p: any): Promise<void> {
    const key = this.keyFor(sessionId, p.requestId);
    const f = this.inFlight.get(key);
    if (!f) return;
    const endedAt = (p.timestamp ?? Date.now() / 1000) * 1000;
    let body: string | undefined;
    let isBase64 = false;
    try {
      // Must address the SAME session the request arrived on, or CDP returns
      // "No resource with given identifier found".
      const r = (await chrome.debugger.sendCommand(f.sessionTarget, 'Network.getResponseBody', {
        requestId: p.requestId,
      })) as any;
      if (r) {
        body = r.body;
        isBase64 = !!r.base64Encoded;
      }
    } catch {
      // Body unavailable (navigation after commit, streamed/worker response, evicted buffer).
    }
    this.listener.onUpdate(f.id, {
      endedAt,
      durationMs: Math.max(0, endedAt - f.startedAt),
      responseBody: body,
      responseSize: typeof p.encodedDataLength === 'number' ? p.encodedDataLength : undefined,
      ...(isBase64 ? { responseMimeType: 'application/octet-stream;base64' } : {}),
    });
    this.inFlight.delete(key);
  }

  private onLoadingFailed(sessionId: string | undefined, p: any): void {
    const key = this.keyFor(sessionId, p.requestId);
    const f = this.inFlight.get(key);
    if (!f) return;
    const endedAt = (p.timestamp ?? Date.now() / 1000) * 1000;
    this.listener.onUpdate(f.id, {
      failed: true,
      errorText: p.errorText,
      endedAt,
      durationMs: Math.max(0, endedAt - f.startedAt),
    });
    this.inFlight.delete(key);
  }

  private onWebSocketCreated(
    tabId: number,
    sessionId: string | undefined,
    target: SessionTarget,
    p: any,
  ): void {
    const reqId = p.requestId as string;
    const url = p.url as string;
    const startedAt = Date.now();
    const key = this.keyFor(sessionId, reqId);
    const id = key;
    const inflight: InFlight = {
      id,
      key,
      tabId,
      sessionTarget: target,
      type: 'WebSocket',
      method: 'GET',
      url,
      host: parseHost(url),
      startedAt,
      requestHeaders: [],
      initiator: p.initiator?.type,
    };
    this.trackInFlight(inflight);
    this.listener.onRequest({
      id,
      tabId,
      type: 'WebSocket',
      method: 'GET',
      url,
      host: inflight.host,
      startedAt,
      requestHeaders: [],
      responseHeaders: [],
      wsMessages: [],
      initiator: inflight.initiator,
    });
  }

  private onWebSocketFrame(
    sessionId: string | undefined,
    p: any,
    direction: 'sent' | 'received',
  ): void {
    const f = this.inFlight.get(this.keyFor(sessionId, p.requestId));
    if (!f) return;
    const r = p.response ?? {};
    const payload = typeof r.payloadData === 'string' ? r.payloadData : '';
    const msg: WebSocketMessage = {
      direction,
      timestamp: (p.timestamp ?? Date.now() / 1000) * 1000,
      opcode: typeof r.opcode === 'number' ? r.opcode : 0,
      payload,
      payloadLength: payload.length,
    };
    this.listener.onWsMessage(f.id, msg);
  }

  private onWebSocketClosed(sessionId: string | undefined, p: any): void {
    const key = this.keyFor(sessionId, p.requestId);
    const f = this.inFlight.get(key);
    if (!f) return;
    const endedAt = (p.timestamp ?? Date.now() / 1000) * 1000;
    this.listener.onUpdate(f.id, {
      endedAt,
      durationMs: Math.max(0, endedAt - f.startedAt),
    });
    this.inFlight.delete(key);
  }
}
