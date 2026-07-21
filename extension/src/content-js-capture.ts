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
    | 'beacon'
    | 'sw-register'
    | 'import-url'
    | 'worker-created';
  url?: string;
  code?: string; // truncated to 4KB
  method?: string;
  headers?: Record<string, string>;
  body?: string; // truncated to 4KB
  timestamp: number;
  pageUrl: string;
};

const MAX_CODE_LENGTH = 4096;
const W = window as unknown as { __harSuiteJsCapture?: boolean };

if (W.__harSuiteJsCapture) {
  // Already running — skip.
} else {
  W.__harSuiteJsCapture = true;

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
  function CapturedFunction(...args: string[]) {
    const body = args[args.length - 1];
    send({
      kind: 'js-capture',
      subtype: 'function-constructor',
      code: truncate(String(body)),
      timestamp: Date.now(),
      pageUrl,
    });
    return new OrigFunction(...args);
  }
  CapturedFunction.prototype = OrigFunction.prototype;
  Object.defineProperty(CapturedFunction, 'toString', { value: () => 'function Function() { [native code] }' });
  (window as any).Function = CapturedFunction;

  // ─── 4. Intercept fetch() ───
  const origFetch = window.fetch;
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    let url: string;
    let method = init?.method ?? 'GET';
    let reqBody: string | undefined;

    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else if (input instanceof Request) {
      url = input.url;
      method = init?.method ?? input.method;
    } else {
      url = String(input);
    }

    if (init?.body) {
      if (typeof init.body === 'string') {
        reqBody = init.body;
      } else if (init.body instanceof ArrayBuffer) {
        reqBody = `[ArrayBuffer ${init.body.byteLength} bytes]`;
      } else if (init.body instanceof FormData) {
        reqBody = '[FormData]';
      } else if (init.body instanceof URLSearchParams) {
        reqBody = init.body.toString();
      }
    }

    send({
      kind: 'js-capture',
      subtype: 'fetch-request',
      url,
      method,
      body: truncate(reqBody),
      timestamp: Date.now(),
      pageUrl,
    });

    const response = await origFetch.call(this, input, init);

    // Clone to read body without consuming the original
    try {
      const clone = response.clone();
      const contentType = clone.headers.get('content-type') ?? '';
      // Only capture text-like responses
      if (
        contentType.includes('json') ||
        contentType.includes('text') ||
        contentType.includes('javascript') ||
        contentType.includes('xml')
      ) {
        const text = await clone.text();
        send({
          kind: 'js-capture',
          subtype: 'fetch-response',
          url,
          method,
          code: truncate(text),
          timestamp: Date.now(),
          pageUrl,
        });
      }
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

    xhr.open = function (method: string, url: string | URL, ...rest: any[]) {
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
      return origOpen(method, url, ...rest);
    };

    xhr.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
      if (body != null) {
        send({
          kind: 'js-capture',
          subtype: 'xhr-send',
          url: reqUrl,
          method: reqMethod,
          body: truncate(typeof body === 'string' ? body : '[non-string body]'),
          timestamp: Date.now(),
          pageUrl,
        });
      }
      return origSend(body);
    };

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
    window.SharedWorker = function (scriptURL: string | URL, name?: string | SharedWorkerOptions) {
      send({
        kind: 'js-capture',
        subtype: 'worker-created',
        url: typeof scriptURL === 'string' ? scriptURL : scriptURL.href,
        timestamp: Date.now(),
        pageUrl,
      });
      return new OrigSharedWorker(scriptURL, name);
    } as any;
    window.SharedWorker.prototype = OrigSharedWorker.prototype;
  }

  console.log('[HAR Suite] JS capture active — inline scripts, eval, fetch/XHR, beacon, workers');
}
