import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  CopyButton,
  Group,
  Modal,
  ScrollArea,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import type { CaptchaDetection, CaptchaType } from '@har-suite/shared';

interface Props {
  items: CaptchaDetection[];
  onClear: () => void;
  onClose: () => void;
}

const LABELS: Record<CaptchaType, string> = {
  'recaptcha-v2': 'reCAPTCHA v2',
  'recaptcha-v3': 'reCAPTCHA v3',
  'recaptcha-enterprise': 'reCAPTCHA Enterprise',
  hcaptcha: 'hCaptcha',
  turnstile: 'Cloudflare Turnstile',
  arkose: 'Arkose Labs / FunCaptcha',
  geetest: 'GeeTest',
  'geetest-v4': 'GeeTest v4',
  datadome: 'DataDome',
  'aws-waf': 'AWS WAF Captcha',
  unknown: 'Unknown',
};

function fmtAge(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

export default function CaptchasPanel({ items, onClear, onClose }: Props) {
  const [filter, setFilter] = useState('');
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const sorted = items.slice().sort((a, b) => b.detectedAt - a.detectedAt);
    if (!q) return sorted;
    return sorted.filter(
      (c) =>
        c.type.includes(q) ||
        c.sitekey.toLowerCase().includes(q) ||
        c.pageHost.toLowerCase().includes(q),
    );
  }, [items, filter]);

  return (
    <Modal
      opened
      onClose={onClose}
      size="xl"
      title={
        <Group gap="xs">
          <Text fw={600}>Detected CAPTCHAs</Text>
          <Badge variant="light" color="violet">
            {items.length}
          </Badge>
        </Group>
      }
    >
      <Group mb="sm" gap="xs">
        <TextInput
          style={{ flex: 1 }}
          placeholder="Filter by type / sitekey / host…"
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
        />
        <Button variant="default" onClick={onClear} disabled={items.length === 0}>
          Clear
        </Button>
      </Group>

      {filtered.length === 0 ? (
        <Text c="dimmed" ta="center" py="xl">
          No CAPTCHAs detected yet on captured pages.
        </Text>
      ) : (
        <ScrollArea.Autosize mah="60vh">
          <Table striped highlightOnHover stickyHeader fz="xs" verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Type</Table.Th>
                <Table.Th>Sitekey</Table.Th>
                <Table.Th>Page</Table.Th>
                <Table.Th>Src</Table.Th>
                <Table.Th>When</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {filtered.map((c) => (
                <Table.Tr key={c.id}>
                  <Table.Td>
                    <Badge variant="light" color="violet" radius="sm">
                      {LABELS[c.type] ?? c.type}
                    </Badge>
                  </Table.Td>
                  <Table.Td ff="monospace">
                    {c.sitekey || (
                      <Text span c="dimmed">
                        (none)
                      </Text>
                    )}
                    {c.extra?.action && (
                      <Text fz={10} c="dimmed">
                        action: {c.extra.action}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td maw={200} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    <Text size="xs" truncate title={c.pageUrl}>
                      {c.pageHost}
                    </Text>
                  </Table.Td>
                  <Table.Td c="dimmed">{c.source}</Table.Td>
                  <Table.Td c="dimmed" title={new Date(c.detectedAt).toISOString()}>
                    {fmtAge(c.detectedAt)}
                  </Table.Td>
                  <Table.Td>
                    <CopyButton value={c.sitekey}>
                      {({ copied, copy }) => (
                        <Button
                          size="compact-xs"
                          variant="default"
                          onClick={copy}
                          disabled={!c.sitekey}
                        >
                          {copied ? 'Copied' : 'Copy'}
                        </Button>
                      )}
                    </CopyButton>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea.Autosize>
      )}

      <Text size="xs" c="dimmed" mt="sm">
        Detected via network requests (incl. cross-origin iframes) + DOM scan + page-world hooks.
      </Text>
    </Modal>
  );
}
