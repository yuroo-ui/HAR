import { useRef, type MouseEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CapturedRequest } from '@har-suite/shared';

interface Props {
  items: CapturedRequest[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onContextMenu: (e: MouseEvent, id: string) => void;
  timeRange: { start: number; end: number };
}

function statusClass(r: CapturedRequest): string {
  if (r.failed) return 'status-failed';
  if (!r.status) return '';
  if (r.status >= 500) return 'status-5xx';
  if (r.status >= 400) return 'status-4xx';
  if (r.status >= 300) return 'status-3xx';
  return 'status-2xx';
}

function fmtSize(n: number | undefined): string {
  if (n == null || n < 0) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtTime(ms: number | undefined): string {
  if (ms == null) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search || '');
  } catch {
    return url;
  }
}

export default function NetworkList({
  items,
  selectedId,
  onSelect,
  onContextMenu,
  timeRange,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rv = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 12,
  });

  const total = Math.max(1, timeRange.end - timeRange.start);

  return (
    <>
      <div className="list-header">
        <div>Type</div>
        <div>Method</div>
        <div>Status</div>
        <div>URL</div>
        <div>Size</div>
        <div>Time</div>
      </div>
      <div className="list-body" ref={parentRef}>
        <div style={{ height: rv.getTotalSize(), position: 'relative', width: '100%' }}>
          {rv.getVirtualItems().map((vi) => {
            const r = items[vi.index];
            const offsetPct = ((r.startedAt - timeRange.start) / total) * 100;
            const widthPct = Math.max(0.5, ((r.durationMs ?? 0) / total) * 100);
            return (
              <div
                key={r.id}
                className={`list-row ${r.id === selectedId ? 'selected' : ''} ${r.failed ? 'failed' : ''}`}
                onClick={() => onSelect(r.id)}
                onContextMenu={(e) => onContextMenu(e, r.id)}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vi.start}px)`,
                  height: vi.size,
                }}
              >
                <div>
                  <span className={`type-pill type-${r.type}`}>{r.type}</span>
                </div>
                <div>{r.method}</div>
                <div className={`status-cell ${statusClass(r)}`}>
                  {r.failed ? 'FAIL' : (r.status ?? '...')}
                </div>
                <div title={r.url}>
                  <span
                    title={r.source === 'app' ? 'Native app traffic' : 'Browser traffic'}
                    style={{ marginRight: 4, opacity: 0.85 }}
                  >
                    {r.source === 'app' ? '🖥' : '🌐'}
                  </span>
                  {r.source === 'app' && r.originProcess?.exe && (
                    <span
                      style={{
                        fontSize: '0.85em',
                        color: 'var(--text-mute)',
                        marginRight: 6,
                        opacity: 0.7,
                      }}
                      title={`Process: ${r.originProcess.exe} (PID: ${r.originProcess.pid})`}
                    >
                      [{r.originProcess.exe}]
                    </span>
                  )}
                  <span style={{ color: 'var(--text-mute)' }}>{r.host}</span>
                  {pathOf(r.url)}
                </div>
                <div>{fmtSize(r.responseSize)}</div>
                <div
                  title={`offset ${Math.round(r.startedAt - timeRange.start)} ms, dur ${fmtTime(r.durationMs)}`}
                >
                  <div className="waterfall-bar">
                    <div
                      className="fill"
                      style={{ left: `${offsetPct}%`, width: `${widthPct}%` }}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
