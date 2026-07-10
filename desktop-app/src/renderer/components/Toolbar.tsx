import {
  ActionIcon,
  Button,
  Checkbox,
  Divider,
  Group,
  SegmentedControl,
  Select,
  TextInput,
  Tooltip,
} from '@mantine/core';
import {
  IconDownload,
  IconEraser,
  IconFileImport,
  IconList,
  IconMoon,
  IconPlayerPlayFilled,
  IconPlayerStopFilled,
  IconShieldLock,
  IconPlugConnected,
  IconSun,
  IconPuzzle,
  IconDeviceDesktop,
  IconTerminal2,
  IconFilter,
} from '@tabler/icons-react';
import type { CaptureScope } from '@har-suite/shared';
import type { TypeFilter, Theme } from '../App';

interface Props {
  filter: string;
  onFilterChange: (v: string) => void;
  typeFilter: TypeFilter;
  onTypeFilterChange: (v: TypeFilter) => void;
  searchBody: boolean;
  onSearchBodyChange: (v: boolean) => void;
  capturing: boolean;
  onToggleCapture: () => void;
  appCapturing: boolean;
  onToggleAppCapture: () => void;
  appCaptureSupported: boolean;
  onCaptureCli: () => void;
  cliGlobalActive: boolean;
  scope: CaptureScope;
  onScopeChange: (s: CaptureScope) => void;
  onClear: () => void;
  onExport: (format: 'har' | 'zip') => void;
  onImport: () => void;
  onAllowlist: () => void;
  onRedaction: () => void;
  onPairing: () => void;
  onCaptchas: () => void;
  onAppFilter: () => void;
  captchaCount: number;
  appFilterCount: number;
  theme: Theme;
  onToggleTheme: () => void;
  total: number;
  filtered: number;
  redactionActive: boolean;
}

export default function Toolbar(p: Props) {
  return (
    <Group className="toolbar" gap="xs" wrap="wrap">
      {/* Capture controls */}
      <Button
        color={p.capturing ? 'red' : 'gray'}
        variant={p.capturing ? 'light' : 'default'}
        leftSection={
          p.capturing ? <IconPlayerStopFilled size={14} /> : <IconPlayerPlayFilled size={14} />
        }
        onClick={p.onToggleCapture}
      >
        {p.capturing ? 'Stop' : 'Record'}
      </Button>

      <Tooltip
        label={
          p.appCaptureSupported
            ? 'Capture native .exe app traffic via a local MITM proxy'
            : 'App capture is only available on Windows'
        }
      >
        <Button
          color={p.appCapturing ? 'teal' : 'gray'}
          variant={p.appCapturing ? 'light' : 'default'}
          leftSection={<IconDeviceDesktop size={14} />}
          onClick={p.onToggleAppCapture}
          disabled={!p.appCaptureSupported}
        >
          {p.appCapturing ? 'Apps ✓' : 'Capture apps'}
        </Button>
      </Tooltip>

      <Tooltip label="Capture CLI / dev-tools (Claude Code, pip, curl, …) by injecting proxy + CA env">
        <Button
          color={p.cliGlobalActive ? 'teal' : 'gray'}
          variant={p.cliGlobalActive ? 'light' : 'default'}
          leftSection={<IconTerminal2 size={14} />}
          onClick={p.onCaptureCli}
        >
          {p.cliGlobalActive ? 'CLI ✓' : 'Capture CLI'}
        </Button>
      </Tooltip>

      <Tooltip label="Capture scope — Data excludes static assets; All includes them">
        <SegmentedControl
          value={p.scope}
          onChange={(v) => p.onScopeChange(v as CaptureScope)}
          data={[
            { label: 'Data', value: 'data' },
            { label: 'All', value: 'all' },
          ]}
        />
      </Tooltip>

      <Button
        variant="default"
        leftSection={<IconEraser size={14} />}
        onClick={p.onClear}
        disabled={p.total === 0}
      >
        Clear
      </Button>

      <Divider orientation="vertical" />

      {/* Filters */}
      <TextInput
        style={{ flex: 1, minWidth: 180 }}
        placeholder="Filter URL / method / status / body…"
        value={p.filter}
        onChange={(e) => p.onFilterChange(e.currentTarget.value)}
      />
      <Checkbox
        size="xs"
        label="body"
        checked={p.searchBody}
        onChange={(e) => p.onSearchBodyChange(e.currentTarget.checked)}
      />
      <Select
        w={130}
        value={p.typeFilter}
        onChange={(v) => p.onTypeFilterChange((v as TypeFilter) ?? 'All')}
        allowDeselect={false}
        comboboxProps={{ withinPortal: true }}
        data={['All', 'Document', 'Fetch', 'XHR', 'WebSocket', 'Script', 'Image', 'Other']}
      />

      <Divider orientation="vertical" />

      {/* Panels */}
      <Button
        variant="subtle"
        color="gray"
        leftSection={<IconList size={14} />}
        onClick={p.onAllowlist}
      >
        Allowlist
      </Button>
      <Button
        variant={p.redactionActive ? 'light' : 'subtle'}
        color={p.redactionActive ? 'yellow' : 'gray'}
        leftSection={<IconShieldLock size={14} />}
        onClick={p.onRedaction}
      >
        Redaction{p.redactionActive ? ' ✓' : ''}
      </Button>
      <Button
        variant="subtle"
        color="gray"
        leftSection={<IconPlugConnected size={14} />}
        onClick={p.onPairing}
      >
        Pairing
      </Button>
      <Button
        variant={p.captchaCount > 0 ? 'light' : 'subtle'}
        color={p.captchaCount > 0 ? 'violet' : 'gray'}
        leftSection={<IconPuzzle size={14} />}
        onClick={p.onCaptchas}
      >
        CAPTCHAs{p.captchaCount > 0 ? ` (${p.captchaCount})` : ''}
      </Button>
      <Button
        variant={p.appFilterCount > 0 ? 'light' : 'subtle'}
        color={p.appFilterCount > 0 ? 'blue' : 'gray'}
        leftSection={<IconFilter size={14} />}
        onClick={p.onAppFilter}
      >
        App Filter{p.appFilterCount > 0 ? ` (${p.appFilterCount})` : ''}
      </Button>

      <div style={{ flex: 1 }} />

      {/* I/O */}
      <Tooltip label="Import an existing HAR file">
        <Button
          variant="subtle"
          color="gray"
          leftSection={<IconFileImport size={14} />}
          onClick={p.onImport}
        >
          Import
        </Button>
      </Tooltip>
      <Button
        leftSection={<IconDownload size={14} />}
        onClick={() => p.onExport('har')}
        disabled={p.filtered === 0}
      >
        Export HAR
      </Button>
      <Button variant="default" onClick={() => p.onExport('zip')} disabled={p.filtered === 0}>
        ZIP
      </Button>
      <Tooltip label="Toggle theme">
        <ActionIcon onClick={p.onToggleTheme} aria-label="Toggle theme">
          {p.theme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
