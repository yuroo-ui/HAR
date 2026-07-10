// Injected into allowlisted pages (and all frames) to detect captchas via the DOM.
// Also injects a page-world hook that intercepts grecaptcha.execute / hcaptcha.execute /
// turnstile.render — those calls reveal sitekeys even when no obvious DOM markers exist.

type DomHit = {
  type: string;
  sitekey: string;
  source?: 'dom' | 'script';
  extra?: Record<string, string>;
};

// Guard against double-injection (extension reload, SPA route change). The script can
// be loaded multiple times into the same realm; we don't want to re-attach observers
// or re-inject the page-world hook each time.
const W = window as unknown as { __harSuiteCaptchaInstalled?: boolean };
if (W.__harSuiteCaptchaInstalled) {
  // Already running — exit silently.
} else {
  W.__harSuiteCaptchaInstalled = true;

  const seen = new Set<string>();

  function send(hit: DomHit) {
    const key = `${hit.type}|${hit.sitekey}`;
    if (seen.has(key)) return;
    seen.add(key);
    try {
      chrome.runtime.sendMessage({
        kind: 'content-captcha-detected',
        type: hit.type,
        sitekey: hit.sitekey,
        source: hit.source ?? 'dom',
        pageUrl: location.href,
        extra: hit.extra,
      });
    } catch {
      // Service worker may be asleep; the network detector will also fire when
      // the captcha widget triggers requests, so this is best-effort only.
    }
  }

  function scan() {
    // 1. Standard widget containers with data-sitekey
    document
      .querySelectorAll<HTMLElement>('.g-recaptcha[data-sitekey], div[data-sitekey].g-recaptcha')
      .forEach((el) => {
        const sitekey = el.dataset.sitekey ?? '';
        const size = el.dataset.size ?? '';
        if (sitekey)
          send({ type: size === 'invisible' ? 'recaptcha-v3' : 'recaptcha-v2', sitekey });
      });
    document.querySelectorAll<HTMLElement>('.h-captcha[data-sitekey]').forEach((el) => {
      const sitekey = el.dataset.sitekey ?? '';
      if (sitekey) send({ type: 'hcaptcha', sitekey });
    });
    document.querySelectorAll<HTMLElement>('.cf-turnstile[data-sitekey]').forEach((el) => {
      const sitekey = el.dataset.sitekey ?? '';
      if (sitekey) send({ type: 'turnstile', sitekey });
    });
    document.querySelectorAll<HTMLElement>('[data-sitekey]').forEach((el) => {
      const sitekey = el.dataset.sitekey ?? '';
      if (!sitekey) return;
      const cls = el.className.toLowerCase();
      if (cls.includes('recaptcha') || cls.includes('h-captcha') || cls.includes('turnstile'))
        return;
      send({ type: 'unknown', sitekey });
    });
    document
      .querySelectorAll<HTMLScriptElement>(
        'script[src*="arkoselabs.com"], script[src*="funcaptcha.com"]',
      )
      .forEach((s) => {
        const m = s.src.match(/\/v2\/([0-9A-F-]{8,})\b/i);
        if (m) send({ type: 'arkose', sitekey: m[1] });
      });

    // 2. Detect captcha iframes directly (many sites embed captchas without standard containers)
    document.querySelectorAll<HTMLIFrameElement>('iframe[src]').forEach((iframe) => {
      const src = iframe.src;
      try {
        const u = new URL(src);
        // reCAPTCHA iframe
        if (
          (u.hostname === 'www.google.com' || u.hostname === 'google.com' || u.hostname === 'www.recaptcha.net' || u.hostname === 'recaptcha.net') &&
          u.pathname.includes('/recaptcha/')
        ) {
          const k = u.searchParams.get('k');
          if (k) send({ type: u.pathname.includes('/enterprise/') ? 'recaptcha-enterprise' : 'recaptcha-v2', sitekey: k });
        }
        // hCaptcha iframe
        if (u.hostname.endsWith('hcaptcha.com')) {
          const m = u.pathname.match(/\/getcaptcha\/([^/?]+)/);
          if (m) send({ type: 'hcaptcha', sitekey: m[1] });
          const sk = u.searchParams.get('sitekey');
          if (sk) send({ type: 'hcaptcha', sitekey: sk });
        }
        // Turnstile iframe
        if (u.hostname.endsWith('challenges.cloudflare.com')) {
          const sk = u.searchParams.get('sitekey');
          if (sk) send({ type: 'turnstile', sitekey: sk });
          else {
            const mk = u.pathname.match(/\/turnstile\/v0\/[a-z0-9]+\/([A-Za-z0-9_-]{8,})/);
            if (mk) send({ type: 'turnstile', sitekey: mk[1] });
          }
        }
      } catch {}
    });

    // 3. Detect h-captcha custom element (web component pattern)
    document.querySelectorAll('h-captcha').forEach((el) => {
      const sitekey = el.getAttribute('sitekey') ?? '';
      if (sitekey) send({ type: 'hcaptcha', sitekey });
    });

    // 4. Detect Turnstile auto-render containers (class="cf-turnstile" without data-sitekey
    //    but with a child iframe from challenges.cloudflare.com)
    document.querySelectorAll<HTMLElement>('.cf-turnstile:not([data-sitekey])').forEach((el) => {
      const iframe = el.querySelector('iframe[src*="challenges.cloudflare.com"]') as HTMLIFrameElement | null;
      if (iframe) {
        try {
          const u = new URL(iframe.src);
          const sk = u.searchParams.get('sitekey');
          if (sk) send({ type: 'turnstile', sitekey: sk });
          else {
            // Turnstile was detected but sitekey not available from URL — still report it
            send({ type: 'turnstile', sitekey: '' });
          }
        } catch {}
      }
    });
  }

  // Initial scan
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan, { once: true });
  } else {
    scan();
  }

  // Debounced MutationObserver — heavy SPAs can fire thousands of mutations
  // per second; we batch rescans into a single rAF tick.
  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      scan();
    });
  }
  const mo = new MutationObserver(schedule);
  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-sitekey', 'class', 'src', 'srcdoc'],
  });

  // ── Page-world hook ──
  // The hook script also self-guards via __harSuiteCaptchaHook so SPA route
  // changes that re-run this content script don't stack wrappers around
  // grecaptcha.execute etc.
  const hook = `
(function() {
  if (window.__harSuiteCaptchaHook) return;
  window.__harSuiteCaptchaHook = true;
  function relay(type, sitekey, extra) {
    window.postMessage({ __harSuiteCaptcha: true, type: type, sitekey: sitekey, extra: extra }, '*');
  }
  function wrap(obj, key, name) {
    if (!obj || typeof obj[key] !== 'function') return;
    if (obj[key].__harSuiteWrapped) return;
    var orig = obj[key];
    var wrapper = function() {
      try {
        var a0 = arguments[0], a1 = arguments[1];
        if (typeof a0 === 'string') relay(name, a0, a1 && a1.action ? { action: a1.action } : undefined);
        else if (a0 && typeof a0 === 'object' && a0.sitekey) relay(name, a0.sitekey, undefined);
        else if (a1 && a1.sitekey) relay(name, a1.sitekey, a1.action ? { action: a1.action } : undefined);
      } catch (e) {}
      return orig.apply(this, arguments);
    };
    wrapper.__harSuiteWrapped = true;
    obj[key] = wrapper;
  }
  function attach(g) {
    if (!g) return;
    wrap(g, 'execute', 'recaptcha-v3');
    wrap(g, 'render', 'recaptcha-v2');
    if (g.enterprise) {
      wrap(g.enterprise, 'execute', 'recaptcha-enterprise');
      wrap(g.enterprise, 'render', 'recaptcha-enterprise');
    }
  }
  // If grecaptcha is already present, attach immediately.
  if (window.grecaptcha) attach(window.grecaptcha);
  if (window.hcaptcha) { wrap(window.hcaptcha, 'execute', 'hcaptcha'); wrap(window.hcaptcha, 'render', 'hcaptcha'); }
  if (window.turnstile) { wrap(window.turnstile, 'render', 'turnstile'); wrap(window.turnstile, 'execute', 'turnstile'); }
  // Intercept future assignments.
  var _g; try { Object.defineProperty(window, 'grecaptcha', {
    configurable: true,
    get: function() { return _g; },
    set: function(v) { _g = v; attach(v); }
  }); } catch (e) {}
  var _h; try { Object.defineProperty(window, 'hcaptcha', {
    configurable: true,
    get: function() { return _h; },
    set: function(v) { _h = v; if (v) { wrap(v, 'execute', 'hcaptcha'); wrap(v, 'render', 'hcaptcha'); } }
  }); } catch (e) {}
  var _t; try { Object.defineProperty(window, 'turnstile', {
    configurable: true,
    get: function() { return _t; },
    set: function(v) { _t = v; if (v) { wrap(v, 'render', 'turnstile'); wrap(v, 'execute', 'turnstile'); } }
  }); } catch (e) {}
})();
`;

  try {
    const s = document.createElement('script');
    s.textContent = hook;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  } catch {}

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__harSuiteCaptcha !== true) return;
    const type = String(d.type ?? '');
    const sitekey = String(d.sitekey ?? '');
    if (!sitekey) return;
    send({ type, sitekey, source: 'script', extra: d.extra });
  });
}
