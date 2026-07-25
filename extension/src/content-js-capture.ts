// content-js-capture.ts
// Injected into every page to capture JavaScript that the CDP Network domain
// cannot see: inline scripts, dynamic script creation, eval/Function, fetch/XHR
// interception, Service Worker registration, and Beacon API calls.
//
// This fills the gap between network-level capture (CDP/MITM) and actual JS
// execution on the page. All captured data is sent to the background script
// via chrome.runtime.sendMessage for unified storage in capture.db.

type JsCaptureEvent = {
  kind: 'js-capture';
  subtype:
    | 'inline-script'
    | 'dynamic-script-src'
    | 'dynamic-script-inline'
    | 'eval'
    | 'function-constructor'
    | 'fetch-request'
    | 'fetch-response'
    | 'xhr-open'
    | 'xhr-send'
    | 'xhr-load'
    | 'beacon'
    | 'sw-register'
    | 'import-url'
    | 'worker-created'
    | 'ws-open'
    | 'ws-send'
    | 'ws-message'
    | 'ws-close';
  url?: string;
  code?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  status?: number;
  mimeType?: string;
  direction?: 'sent' | 'received';
  captureId?: string;
  timestamp: number;
  pageUrl: string;
};

function isJsCaptchaProviderFrame(): boolean {
  try {
    const h = location.hostname;
    return (
      h.endsWith('challenges.cloudflare.com') ||
      h.endsWith('hcaptcha.com') ||
      h.endsWith('recaptcha.net') ||
      (h === 'www.google.com' && location.pathname.includes('/recaptcha/')) ||
      h.endsWith('funcaptcha.com') ||
      h.endsWith('arkoselabs.com')
    );
  } catch {
    return false;
  }
}

const MAX_CODE_LENGTH = 200_000;
const MAX_WS_PAYLOAD = 64_000;
const _W = window as unknown as { __harSuiteJsCapture?: boolean };

// Never instrument captcha provider frames — breaks Turnstile postMessage (300030).
if (isJsCaptchaProviderFrame()) {
  // no-op
} else if (_W.__harSuiteJsCapture) {
  // Already running — skip.
} else {
  _W.__harSuiteJsCapture = true;

  function send(event: JsCaptureEvent) {
    try {
      chrome.runtime.sendMessage(event);
    } catch {
      // Service worker may be asleep; best-effort.
    }
  }

  function truncate(s: string | undefined | null): string | undefined {
    if (!s) return undefined;
    return s.length > MAX_CODE_LENGTH ? s.slice(0, MAX_CODE_LENGTH) + '…[truncated]' : s;
  }

  const pageUrl = location.href;

  // ─── 1. Capture existing inline scripts on page load ───
  function captureInlineScripts() {
    document.querySelectorAll<HTMLScriptElement>('script:not([src])').forEach((el) => {
      const code = el.textContent?.trim();
      if (code && code.length > 0) {
        send({
          kind: 'js-capture',
          subtype: 'inline-script',
          code: truncate(code),
          timestamp: Date.now(),
          pageUrl,
        });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', captureInlineScripts, { once: true });
  } else {
    captureInlineScripts();
  }

  // ─── 2. MutationObserver for dynamically added scripts ───
  const seenScripts = new WeakSet<HTMLScriptElement>();

  function scanNewScripts(mutations: MutationRecord[]) {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as Element;

        // Direct <script> element
        if (el.tagName === 'SCRIPT') {
          handleScriptElement(el as HTMLScriptElement);
        }

        // Scripts inside added subtree
        el.querySelectorAll?.('script').forEach((s) => handleScriptElement(s));
      }
    }
  }

  function handleScriptElement(el: HTMLScriptElement) {
    if (seenScripts.has(el)) return;
    seenScripts.add(el);

    if (el.src) {
      send({
        kind: 'js-capture',
        subtype: 'dynamic-script-src',
        url: el.src,
        timestamp: Date.now(),
        pageUrl,
      });
    } else {
      const code = el.textContent?.trim();
      if (code && code.length > 0) {
        send({
          kind: 'js-capture',
          subtype: 'dynamic-script-inline',
          code: truncate(code),
          timestamp: Date.now(),
          pageUrl,
        });
      }
    }
  }

  const scriptObserver = new MutationObserver(scanNewScripts);
  scriptObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // ─── 3. Intercept eval() and Function() constructor ───
  const origEval = window.eval;
  window.eval = function (code: string) {
    send({
      kind: 'js-capture',
      subtype: 'eval',
      code: truncate(String(code)),
      timestamp: Date.now(),
      pageUrl,
    });
    return origEval.call(this, code);
  };
  // Preserve toString
  Object.defineProperty(window.eval, 'toString', { value: () => 'function eval() { [native code] }' });

  const OrigFunction = Function;
  function CapturedFunction(this: unknown, ...args: string[]): unknown {
    const body = args.length > 0 ? args[args.length - 1] : '';
    send({
      kind: 'js-capture',
      subtype: 'function-constructor',
      code: truncate(String(body)),
      timestamp: Date.now(),
      pageUrl,
    });
    return new (OrigFunction as any)(...args);
  }
  CapturedFunction.prototype = OrigFunction.prototype;
  Object.defineProperty(CapturedFunction, 'toString', { value: () => 'function Function() { [native code] }' });
  (window as any).Function = CapturedFunction;

  // ─── 4. Intercept fetch() (request + response body for mobile parity) ───
  function bodyToString(body: any): string | undefined {
    if (body == null) return undefined;
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof ArrayBuffer) return JSON.stringify({ __binary: true, kind: 'ArrayBuffer', byteLength: body.byteLength });
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView?.(body)) {
      return JSON.stringify({ __binary: true, kind: 'TypedArray', byteLength: body.byteLength, type: (body as any).constructor?.name });
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      return JSON.stringify({ __binary: true, kind: 'Blob', size: body.size, type: body.type || '' });
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      try {
        const parts: Array<Record<string, unknown>> = [];
        body.forEach((v, k) => {
          if (typeof v === 'string') parts.push({ name: k, type: 'string', value: v.slice(0, 2000) });
          else parts.push({
            name: k,
            type: 'file',
            fileName: (v as File).name || 'blob',
            size: (v as File).size || 0,
            mimeType: (v as File).type || '',
            lastModified: (v as File).lastModified || null,
          });
        });
        return JSON.stringify({ __multipart: true, parts });
      } catch {
        return JSON.stringify({ __multipart: true, parts: [] });
      }
    }
    try { return String(body); } catch { return undefined; }
  }

  const origFetch = window.fetch;
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    let url: string;
    let method = init?.method ?? 'GET';
    let reqBody: string | undefined;
    let headers: Record<string, string> | undefined;
    const captureId = `jsfetch:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else if (input instanceof Request) {
      url = input.url;
      method = init?.method ?? input.method;
      try {
        if (!init?.body && input.clone) {
          const ct = input.headers?.get?.('content-type') || '';
          if (ct.includes('json') || ct.includes('text') || ct.includes('x-www-form-urlencoded')) {
            reqBody = await input.clone().text();
          }
        }
      } catch {}
    } else {
      url = String(input);
    }

    if (init?.body != null) reqBody = bodyToString(init.body);
    try {
      if (init?.headers) {
        headers = {};
        if (init.headers instanceof Headers) init.headers.forEach((v, k) => { headers![k] = v; });
        else if (Array.isArray(init.headers)) for (const [k, v] of init.headers) headers[k] = String(v);
        else headers = { ...(init.headers as any) };
      }
    } catch {}

    send({
      kind: 'js-capture',
      subtype: 'fetch-request',
      url,
      method,
      headers,
      body: truncate(reqBody),
      captureId,
      timestamp: Date.now(),
      pageUrl,
    });

    const response = await origFetch.call(this, input, init);

    try {
      const clone = response.clone();
      const contentType = clone.headers.get('content-type') ?? '';
      const respHeaders: Record<string, string> = {};
      clone.headers.forEach((v, k) => { respHeaders[k] = v; });
      let text: string | undefined;
      // Prefer text-like; still attempt text for unknown small responses
      if (
        contentType.includes('json') ||
        contentType.includes('text') ||
        contentType.includes('javascript') ||
        contentType.includes('xml') ||
        contentType.includes('html') ||
        contentType === ''
      ) {
        text = await clone.text();
      } else {
        text = `[binary content-type=${contentType}]`;
      }
      send({
        kind: 'js-capture',
        subtype: 'fetch-response',
        url,
        method,
        headers: respHeaders,
        code: truncate(text),
        status: response.status,
        mimeType: contentType,
        captureId,
        timestamp: Date.now(),
        pageUrl,
      });
    } catch {
      // Body read failed — ignore.
    }

    return response;
  };
  Object.defineProperty(window.fetch, 'toString', { value: () => 'function fetch() { [native code] }' });

  // ─── 5. Intercept XMLHttpRequest ───
  const OrigXHR = XMLHttpRequest;
  function CapturedXHR() {
    const xhr = new OrigXHR();
    const origOpen = xhr.open.bind(xhr);
    const origSend = xhr.send.bind(xhr);

    let reqUrl: string;
    let reqMethod: string;

    xhr.open = function (method: string, url: string | URL, async?: boolean, user?: string, password?: string) {
      reqMethod = method;
      reqUrl = typeof url === 'string' ? url : url.href;
      send({
        kind: 'js-capture',
        subtype: 'xhr-open',
        url: reqUrl,
        method: reqMethod,
        timestamp: Date.now(),
        pageUrl,
      });
      return origOpen(method, url, async ?? true, user, password);
    };

    const captureId = `jsxhr:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    xhr.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
      if (body != null) {
        send({
          kind: 'js-capture',
          subtype: 'xhr-send',
          url: reqUrl,
          method: reqMethod,
          body: truncate(typeof body === 'string' ? body : bodyToString(body)),
          captureId,
          timestamp: Date.now(),
          pageUrl,
        });
      }
      return origSend(body);
    };

    xhr.addEventListener('loadend', function () {
      try {
        const ct = xhr.getResponseHeader('content-type') || '';
        let bodyText: string | undefined;
        if (typeof xhr.responseText === 'string') bodyText = xhr.responseText;
        send({
          kind: 'js-capture',
          subtype: 'xhr-load',
          url: reqUrl,
          method: reqMethod,
          status: xhr.status,
          mimeType: ct,
          code: truncate(bodyText),
          captureId,
          timestamp: Date.now(),
          pageUrl,
        });
      } catch {}
    });

    return xhr;
  }
  CapturedXHR.prototype = OrigXHR.prototype;
  Object.defineProperty(CapturedXHR, 'toString', { value: () => 'function XMLHttpRequest() { [native code] }' });
  (window as any).XMLHttpRequest = CapturedXHR;

  // ─── 6. Intercept navigator.sendBeacon() ───
  const origBeacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = function (url: string | URL, data?: BodyInit | null): boolean {
    let bodyStr: string | undefined;
    if (data != null) {
      if (typeof data === 'string') bodyStr = data;
      else if (data instanceof Blob) bodyStr = `[Blob ${data.size} bytes]`;
      else if (data instanceof ArrayBuffer) bodyStr = `[ArrayBuffer ${data.byteLength} bytes]`;
      else if (data instanceof FormData) bodyStr = '[FormData]';
      else if (data instanceof URLSearchParams) bodyStr = data.toString();
    }
    send({
      kind: 'js-capture',
      subtype: 'beacon',
      url: typeof url === 'string' ? url : url.href,
      method: 'POST',
      body: truncate(bodyStr),
      timestamp: Date.now(),
      pageUrl,
    });
    return origBeacon(url, data);
  };

  // ─── 7. Intercept Service Worker registrations ───
  if ('serviceWorker' in navigator) {
    const origRegister = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = function (scriptURL: string | URL, options?: RegistrationOptions) {
      send({
        kind: 'js-capture',
        subtype: 'sw-register',
        url: typeof scriptURL === 'string' ? scriptURL : scriptURL.href,
        timestamp: Date.now(),
        pageUrl,
      });
      return origRegister(scriptURL, options);
    };
  }

  // ─── 8. Intercept dynamic import() ───
  // import() is a keyword expression, not a function, so we can't wrap it directly.
  // Instead, we intercept the <script type="module"> src attribute and inline modules.
  const moduleObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as Element;
        if (el.tagName === 'SCRIPT' && (el as HTMLScriptElement).type === 'module') {
          const src = (el as HTMLScriptElement).src;
          if (src) {
            send({
              kind: 'js-capture',
              subtype: 'dynamic-script-src',
              url: src,
              timestamp: Date.now(),
              pageUrl,
            });
          } else {
            const code = el.textContent?.trim();
            if (code) {
              send({
                kind: 'js-capture',
                subtype: 'inline-script',
                code: truncate(code),
                timestamp: Date.now(),
                pageUrl,
              });
            }
          }
        }
      }
    }
  });
  moduleObserver.observe(document.documentElement, { childList: true, subtree: true });

  // ─── 9. Intercept Worker/SharedWorker creation ───
  const OrigWorker = window.Worker;
  const OrigSharedWorker = window.SharedWorker;

  window.Worker = function (scriptURL: string | URL, options?: WorkerOptions) {
    send({
      kind: 'js-capture',
      subtype: 'worker-created',
      url: typeof scriptURL === 'string' ? scriptURL : scriptURL.href,
      timestamp: Date.now(),
      pageUrl,
    });
    return new OrigWorker(scriptURL, options);
  } as any;
  window.Worker.prototype = OrigWorker.prototype;

  if (OrigSharedWorker) {
    (window as any).SharedWorker = function (scriptURL: string | URL, name?: string | WorkerOptions) {
      send({
        kind: 'js-capture',
        subtype: 'worker-created',
        url: typeof scriptURL === 'string' ? scriptURL : scriptURL.href,
        timestamp: Date.now(),
        pageUrl,
      });
      return new (OrigSharedWorker as any)(scriptURL, name);
    };
    (window as any).SharedWorker.prototype = OrigSharedWorker.prototype;
  }

  // ─── 10. WebSocket frames (mobile parity with desktop CDP ws-message) ───
  const OrigWebSocket = window.WebSocket;
  function CapturedWebSocket(this: any, url: string | URL, protocols?: string | string[]) {
    const ws = protocols !== undefined ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
    const wsUrl = typeof url === 'string' ? url : url.href;
    const captureId = `jsws:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    send({
      kind: 'js-capture',
      subtype: 'ws-open',
      url: wsUrl,
      method: 'GET',
      captureId,
      timestamp: Date.now(),
      pageUrl,
    });
    const origSend = ws.send.bind(ws);
    ws.send = function (data: any) {
      let payload: string;
      if (typeof data === 'string') payload = data.slice(0, MAX_WS_PAYLOAD);
      else if (data instanceof ArrayBuffer) payload = `[ArrayBuffer ${data.byteLength} bytes]`;
      else if (ArrayBuffer.isView?.(data)) payload = `[TypedArray ${data.byteLength} bytes]`;
      else if (data instanceof Blob) payload = `[Blob ${data.size} bytes]`;
      else payload = String(data).slice(0, MAX_WS_PAYLOAD);
      send({
        kind: 'js-capture',
        subtype: 'ws-send',
        url: wsUrl,
        body: payload,
        direction: 'sent',
        captureId,
        timestamp: Date.now(),
        pageUrl,
      });
      return origSend(data);
    };
    ws.addEventListener('message', (ev: MessageEvent) => {
      let payload: string;
      const data = ev.data;
      if (typeof data === 'string') payload = data.slice(0, MAX_WS_PAYLOAD);
      else if (data instanceof ArrayBuffer) payload = `[ArrayBuffer ${data.byteLength} bytes]`;
      else if (data instanceof Blob) payload = `[Blob ${data.size} bytes]`;
      else payload = String(data).slice(0, MAX_WS_PAYLOAD);
      send({
        kind: 'js-capture',
        subtype: 'ws-message',
        url: wsUrl,
        body: payload,
        direction: 'received',
        captureId,
        timestamp: Date.now(),
        pageUrl,
      });
    });
    ws.addEventListener('close', () => {
      send({
        kind: 'js-capture',
        subtype: 'ws-close',
        url: wsUrl,
        captureId,
        timestamp: Date.now(),
        pageUrl,
      });
    });
    return ws;
  }
  CapturedWebSocket.prototype = OrigWebSocket.prototype;
  Object.defineProperty(CapturedWebSocket, 'CONNECTING', { value: OrigWebSocket.CONNECTING });
  Object.defineProperty(CapturedWebSocket, 'OPEN', { value: OrigWebSocket.OPEN });
  Object.defineProperty(CapturedWebSocket, 'CLOSING', { value: OrigWebSocket.CLOSING });
  Object.defineProperty(CapturedWebSocket, 'CLOSED', { value: OrigWebSocket.CLOSED });
  Object.defineProperty(CapturedWebSocket, 'toString', { value: () => 'function WebSocket() { [native code] }' });
  (window as any).WebSocket = CapturedWebSocket;

  // bfcache restore signal
  window.addEventListener('pageshow', (ev) => {
    if ((ev as PageTransitionEvent).persisted) {
      send({
        kind: 'js-capture',
        subtype: 'inline-script',
        code: '[bfcache-restore pageshow persisted=true]',
        timestamp: Date.now(),
        pageUrl: location.href,
      });
    }
  });

  console.log('[HAR Suite] JS capture active — fetch/XHR body, WS frames, eval, beacon, workers');
}
