import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Badge, Button, Group, Text, Tooltip } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import type { Session } from '@har-suite/shared';

interface Props {
  sessions: Session[];
  currentId: number | null;
  onNew: () => void;
  onOpen: (id: number) => void;
  onDelete: (id: number) => void;
  onRename: (id: number, name: string) => void;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function SessionsSidebar({
  sessions,
  currentId,
  onNew,
  onOpen,
  onDelete,
  onRename,
}: Props) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId != null) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editingId]);

  const startEdit = (s: Session) => {
    setEditingId(s.id);
    setDraft(s.name);
  };
  const commitEdit = () => {
    if (editingId != null) {
      const name = draft.trim();
      if (name) onRename(editingId, name);
    }
    setEditingId(null);
  };

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <h3>Sessions</h3>
        <Tooltip label="New session">
          <ActionIcon variant="subtle" color="gray" onClick={onNew} aria-label="New session">
            <IconPlus size={16} />
          </ActionIcon>
        </Tooltip>
      </div>
      <div className="session-list">
        {sessions.length === 0 ? (
          <Text className="sidebar-empty" c="dimmed" size="sm">
            No sessions yet
          </Text>
        ) : (
          sessions.map((s) => (
            <div
              key={s.id}
              className={`session ${s.id === currentId ? 'active' : ''}`}
              onClick={() => editingId !== s.id && onOpen(s.id)}
              onDoubleClick={() => startEdit(s)}
              onContextMenu={(e) => {
                e.preventDefault();
                if (confirm(`Delete session "${s.name}"?`)) onDelete(s.id);
              }}
              title="Click to open · double-click to rename · right-click to delete"
            >
              {editingId === s.id ? (
                <input
                  ref={inputRef}
                  className="session-rename"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEdit();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                />
              ) : (
                <div className="session-name">{s.name}</div>
              )}
              <Group gap={7} className="meta" mt={4}>
                <Badge size="xs" variant="default" radius="xl">
                  {s.count}
                </Badge>
                <Text fz={11} c="dimmed">
                  {fmtDate(s.createdAt)}
                </Text>
              </Group>
            </div>
          ))
        )}
      </div>
      <div className="actions">
        <Button fullWidth onClick={onNew} leftSection={<IconPlus size={14} />}>
          New session
        </Button>
      </div>
    </div>
  );
}
