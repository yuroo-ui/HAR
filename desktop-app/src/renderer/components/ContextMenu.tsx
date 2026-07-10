import { Menu } from '@mantine/core';

export type CtxItem =
  | { label: string; action: () => void | Promise<void>; sep?: false }
  | { sep: true; label?: never; action?: never };

interface Props {
  x: number;
  y: number;
  items: CtxItem[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, items, onClose }: Props) {
  return (
    <Menu opened onClose={onClose} position="bottom-start" withinPortal shadow="md" width={210}>
      {/* Zero-size target anchored at the cursor position. */}
      <Menu.Target>
        <div style={{ position: 'fixed', left: x, top: y, width: 0, height: 0 }} />
      </Menu.Target>
      <Menu.Dropdown>
        {items.map((it, i) =>
          it.sep ? (
            <Menu.Divider key={`s-${i}`} />
          ) : (
            <Menu.Item
              key={it.label}
              onClick={async () => {
                await it.action();
                onClose();
              }}
            >
              {it.label}
            </Menu.Item>
          ),
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
