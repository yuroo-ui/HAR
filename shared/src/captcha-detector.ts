import type { CaptchaDetection, CaptchaType } from './index';

export interface DetectionInput {
  url: string;
  pageUrl: string;
  pageHost: string;
  requestId?: string;
  tabId?: number;
  requestBody?: string;
}

interface Matcher {
  test: (
    u: URL,
    fullUrl: string,
    body?: string,
  ) => Pick<CaptchaDetection, 'type' | 'sitekey' | 'extra'> | null;
}

const matchers: Matcher[] = [
  // reCAPTCHA Enterprise
  {
    test: (u) => {
      if (!isGoogleRecaptchaHost(u.hostname)) return null;
      if (!u.pathname.includes('/recaptcha/enterprise/')) return null;
      const k = u.searchParams.get('k');
      if (!k) return null;
      const extra: Record<string, string> = {};
      const co = u.searchParams.get('co');
      if (co) extra.co = co;
      return {
        type: 'recaptcha-enterprise',
        sitekey: k,
        extra: Object.keys(extra).length ? extra : undefined,
      };
    },
  },
  // reCAPTCHA script load: /recaptcha/enterprise.js?render=<sitekey>
  {
    test: (u) => {
      if (!isGoogleRecaptchaHost(u.hostname)) return null;
      if (!u.pathname.startsWith('/recaptcha/enterprise.js')) return null;
      const k = u.searchParams.get('render');
      if (!k) return null;
      return { type: 'recaptcha-enterprise', sitekey: k };
    },
  },
  // reCAPTCHA v2 / v3 (api2)
  {
    test: (u) => {
      if (!isGoogleRecaptchaHost(u.hostname)) return null;
      if (!u.pathname.startsWith('/recaptcha/api2/')) return null;
      const k = u.searchParams.get('k');
      if (!k) return null;
      const size = u.searchParams.get('size') ?? '';
      // v3 anchor uses size=invisible; reload also frequent on v3.
      const type: CaptchaType =
        size === 'invisible' || u.pathname.includes('/reload') || u.pathname.includes('/userverify')
          ? 'recaptcha-v3'
          : 'recaptcha-v2';
      const extra: Record<string, string> = {};
      const co = u.searchParams.get('co');
      if (co) extra.co = co;
      return { type, sitekey: k, extra: Object.keys(extra).length ? extra : undefined };
    },
  },
  // reCAPTCHA script load: /recaptcha/api.js?render=<sitekey>
  {
    test: (u) => {
      if (!isGoogleRecaptchaHost(u.hostname)) return null;
      if (!u.pathname.startsWith('/recaptcha/api.js')) return null;
      const k = u.searchParams.get('render');
      if (!k) return null;
      // If render=explicit, no sitekey embedded — skip
      if (k === 'explicit') return null;
      return { type: 'recaptcha-v3', sitekey: k };
    },
  },
  // hCaptcha
  {
    test: (u) => {
      if (!u.hostname.endsWith('hcaptcha.com')) return null;
      // /getcaptcha/<sitekey>
      const mGet = u.pathname.match(/\/getcaptcha\/([^/?]+)/);
      if (mGet) return { type: 'hcaptcha', sitekey: mGet[1] };
      // /checkcaptcha/<sitekey>/<uuid>
      const mChk = u.pathname.match(/\/checkcaptcha\/([^/?]+)/);
      if (mChk) return { type: 'hcaptcha', sitekey: mChk[1] };
      // query
      const sk = u.searchParams.get('sitekey');
      if (sk) return { type: 'hcaptcha', sitekey: sk };
      return null;
    },
  },
  // Cloudflare Turnstile
  {
    test: (u) => {
      if (!u.hostname.endsWith('challenges.cloudflare.com')) return null;
      const sk = u.searchParams.get('sitekey');
      if (sk) return { type: 'turnstile', sitekey: sk };
      // The Turnstile iframe URL embeds sitekey under various names sometimes
      const mk = u.pathname.match(/\/turnstile\/v0\/[a-z0-9]+\/([A-Za-z0-9_-]{8,})/);
      if (mk) return { type: 'turnstile', sitekey: mk[1] };
      // Connection to challenges.cloudflare.com itself is signal enough
      return { type: 'turnstile', sitekey: '' };
    },
  },
  // Arkose Labs / FunCaptcha
  {
    test: (u) => {
      const h = u.hostname;
      if (
        !(
          h.endsWith('arkoselabs.com') ||
          h.endsWith('funcaptcha.com') ||
          h.endsWith('arkose-labs.com')
        )
      )
        return null;
      // /v2/<PUBLIC_KEY>/api.js or /v2/<PUBLIC_KEY>/...
      const mPath = u.pathname.match(/\/v2\/([0-9A-F-]{8,})\b/i);
      if (mPath) return { type: 'arkose', sitekey: mPath[1] };
      const pk =
        u.searchParams.get('public_key') ||
        u.searchParams.get('publickey') ||
        u.searchParams.get('key') ||
        u.searchParams.get('pkey');
      if (pk) return { type: 'arkose', sitekey: pk };
      return { type: 'arkose', sitekey: '' };
    },
  },
  // GeeTest v3 / v4
  {
    test: (u) => {
      const h = u.hostname;
      if (!(h.endsWith('geetest.com') || h.endsWith('geevisit.com'))) return null;
      const gt = u.searchParams.get('gt') ?? '';
      const challenge = u.searchParams.get('challenge') ?? '';
      const captchaId = u.searchParams.get('captcha_id') ?? '';
      // v4 uses /load with captcha_id, no gt+challenge
      if (captchaId && !gt) {
        return { type: 'geetest-v4', sitekey: captchaId };
      }
      if (gt) {
        return {
          type: 'geetest',
          sitekey: gt,
          extra: challenge ? { challenge } : undefined,
        };
      }
      return null;
    },
  },
  // DataDome
  {
    test: (u) => {
      const h = u.hostname;
      if (
        h.endsWith('captcha-delivery.com') ||
        h.endsWith('datadome.co') ||
        h.endsWith('datado.me')
      ) {
        const cid = u.searchParams.get('cid') ?? u.searchParams.get('initialCid') ?? '';
        return { type: 'datadome', sitekey: '', extra: cid ? { cid } : undefined };
      }
      return null;
    },
  },
  // AWS WAF Captcha
  {
    test: (u) => {
      const h = u.hostname;
      if (h.endsWith('awswaf.com') || h.endsWith('captcha-prod.awswaf.com')) {
        return { type: 'aws-waf', sitekey: '' };
      }
      return null;
    },
  },
];

function isGoogleRecaptchaHost(h: string): boolean {
  return (
    h === 'www.google.com' ||
    h === 'google.com' ||
    h === 'www.recaptcha.net' ||
    h === 'recaptcha.net'
  );
}

export function detectFromUrl(input: DetectionInput): CaptchaDetection | null {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return null;
  }
  for (const m of matchers) {
    const hit = m.test(parsed, input.url, input.requestBody);
    if (hit) {
      return {
        id: stableId(hit.type, hit.sitekey, input.pageHost),
        type: hit.type,
        sitekey: hit.sitekey,
        pageUrl: input.pageUrl,
        pageHost: input.pageHost,
        sourceUrl: input.url,
        source: 'network',
        detectedAt: Date.now(),
        tabId: input.tabId,
        requestId: input.requestId,
        extra: hit.extra,
      };
    }
  }
  return null;
}

export function stableId(type: string, sitekey: string, pageHost: string): string {
  // Cheap deterministic hash; collisions don't matter for UI deduping.
  const s = `${type}|${sitekey}|${pageHost}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}
