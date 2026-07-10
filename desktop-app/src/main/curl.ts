import type { CapturedRequest } from '@har-suite/shared';

function shellQuote(s: string): string {
  if (s === '') return "''";
  // POSIX shell single-quote escape
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

export function toCurl(req: CapturedRequest): string {
  const parts = ['curl', '-X', req.method, shellQuote(req.url)];
  for (const h of req.requestHeaders) {
    if (h.name.startsWith(':')) continue;
    parts.push('-H', shellQuote(`${h.name}: ${h.value}`));
  }
  if (req.requestBody) {
    parts.push('--data-raw', shellQuote(req.requestBody));
  }
  return parts.join(' ');
}

export function toFetch(req: CapturedRequest): string {
  const headers = req.requestHeaders.reduce<Record<string, string>>((acc, h) => {
    if (!h.name.startsWith(':')) acc[h.name] = h.value;
    return acc;
  }, {});
  const init: Record<string, unknown> = {
    method: req.method,
    headers,
  };
  if (req.requestBody) init.body = req.requestBody;
  return `fetch(${JSON.stringify(req.url)}, ${JSON.stringify(init, null, 2)});`;
}
