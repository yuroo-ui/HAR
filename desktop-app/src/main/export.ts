import { writeFile } from 'node:fs/promises';
import JSZip from 'jszip';
import type { CapturedRequest, RedactionConfig } from '@har-suite/shared';
import { buildHar } from './har';
import { redactAll } from './redact';

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
}

export async function exportHar(
  requests: CapturedRequest[],
  destPath: string,
  redaction: RedactionConfig,
): Promise<number> {
  const items = redactAll(requests, redaction);
  const har = buildHar(items);
  await writeFile(destPath, JSON.stringify(har, null, 2), 'utf8');
  return items.length;
}

export async function exportZip(
  requests: CapturedRequest[],
  destPath: string,
  redaction: RedactionConfig,
): Promise<number> {
  const items = redactAll(requests, redaction);
  const zip = new JSZip();
  const har = buildHar(items);
  zip.file('capture.har', JSON.stringify(har, null, 2));

  const summary = items
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((r) => ({
      id: r.id,
      type: r.type,
      method: r.method,
      url: r.url,
      status: r.status ?? null,
      durationMs: r.durationMs ?? null,
      startedAt: new Date(r.startedAt).toISOString(),
      responseSize: r.responseSize ?? null,
    }));
  zip.file('summary.json', JSON.stringify(summary, null, 2));

  const requestsFolder = zip.folder('requests');
  if (requestsFolder) {
    for (const req of items) {
      const fname = `${safeName(req.id)}__${safeName(req.method)}__${safeName(req.host)}.json`;
      requestsFolder.file(fname, JSON.stringify(req, null, 2));
    }
  }

  const meta = {
    exportedAt: new Date().toISOString(),
    tool: 'HAR Capture Suite',
    version: '0.1.0',
    count: items.length,
    redacted: redaction.enabled,
  };
  zip.file('metadata.json', JSON.stringify(meta, null, 2));

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await writeFile(destPath, buf);
  return items.length;
}
