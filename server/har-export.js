/**
 * HAR 1.2 builder for remote server exports (parity with desktop-app har.ts)
 */
export function buildHar(requests = [], { creatorName = 'HAR Capture Suite', creatorVersion = '0.4.0' } = {}) {
  const entries = (requests || [])
    .slice()
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
    .map((req) => buildEntry(req));

  // Link redirect chains when redirectURL / status 3xx present
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const status = e.response?.status || 0;
    if (status >= 300 && status < 400) {
      const loc = (e.response.headers || []).find((h) => String(h.name).toLowerCase() === 'location')?.value;
      if (loc) {
        e.response.redirectURL = loc;
        // find next entry with matching url if relative/absolute
        const abs = absolutize(e.request.url, loc);
        for (let j = i + 1; j < Math.min(i + 8, entries.length); j++) {
          if (entries[j].request.url === abs || entries[j].request.url === loc) {
            e._redirectTo = entries[j]._id || entries[j].request.url;
            entries[j]._redirectFrom = e._id || e.request.url;
            break;
          }
        }
      }
    }
  }

  return {
    log: {
      version: '1.2',
      creator: { name: creatorName, version: creatorVersion },
      pages: [
        {
          startedDateTime: entries[0]?.startedDateTime || new Date().toISOString(),
          id: 'page_1',
          title: 'HAR Capture Session',
          pageTimings: { onContentLoad: -1, onLoad: -1 },
        },
      ],
      entries,
    },
  };
}

function absolutize(base, loc) {
  try {
    return new URL(loc, base).href;
  } catch {
    return loc;
  }
}

function isoTime(ms) {
  return new Date(ms || Date.now()).toISOString();
}

function bodySizeOf(body) {
  if (!body) return -1;
  return Buffer.byteLength(String(body), 'utf8');
}

function parseQuery(url) {
  try {
    const u = new URL(url);
    return Array.from(u.searchParams.entries()).map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function buildEntry(req) {
  const startedDateTime = isoTime(req.startedAt);
  const time = req.durationMs ?? (req.endedAt && req.startedAt ? Math.max(0, req.endedAt - req.startedAt) : 0);
  const queryString = parseQuery(req.url || '');
  const postData = req.requestBody
    ? {
        mimeType:
          (req.requestHeaders || []).find((h) => String(h.name).toLowerCase() === 'content-type')?.value ||
          'text/plain',
        text: req.requestBody,
      }
    : undefined;

  const isBase64 =
    req.responseBodyBase64 === true || req.responseMimeType === 'application/octet-stream;base64';
  const content = {
    size: req.responseSize ?? bodySizeOf(req.responseBody),
    mimeType: req.responseMimeType || '',
    text: req.responseBody || '',
  };
  if (isBase64) content.encoding = 'base64';

  const entry = {
    pageref: 'page_1',
    startedDateTime,
    time,
    request: {
      method: req.method || 'GET',
      url: req.url || '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: req.requestHeaders || [],
      queryString,
      headersSize: -1,
      bodySize: bodySizeOf(req.requestBody),
      ...(postData ? { postData } : {}),
    },
    response: {
      status: req.status ?? 0,
      statusText: req.statusText || '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: req.responseHeaders || [],
      content,
      redirectURL: req.redirectURL || '',
      headersSize: -1,
      bodySize: req.responseSize ?? -1,
    },
    cache: {},
    timings: {
      blocked: -1,
      dns: -1,
      connect: -1,
      ssl: -1,
      send: 0,
      wait: time,
      receive: 0,
    },
    _id: req.id,
    _resourceType: req.type,
    _initiator: req.initiator,
    _tabId: req.tabId,
    _fromCache: !!req.fromCache,
  };

  if (req.type === 'WebSocket' && Array.isArray(req.wsMessages)) {
    entry._webSocketMessages = req.wsMessages.map((m) => ({
      type: m.direction === 'sent' ? 'send' : 'receive',
      time: (m.timestamp || Date.now()) / 1000,
      opcode: m.opcode ?? 1,
      data: m.payload,
      ...(m.isBinary || m.opcode === 2 ? { encoding: 'base64' } : {}),
    }));
  }

  return entry;
}
