import { useState } from 'react';
import { Alert, Button, Group, List, Modal, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconDeviceDesktop } from '@tabler/icons-react';

interface Props {
  onClose: () => void;
  onEnable: () => Promise<void> | void;
}

// First-run explainer for native-app capture. Capturing .exe traffic requires
// trusting a local CA and pointing the Windows proxy at us — be upfront about
// what that does and what it can't capture.
export default function AppCaptureDialog({ onClose, onEnable }: Props) {
  const [busy, setBusy] = useState(false);

  const enable = async () => {
    setBusy(true);
    try {
      await onEnable();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      opened
      onClose={onClose}
      title={
        <Group gap={8}>
          <IconDeviceDesktop size={18} />
          <Text fw={600}>Capture native app traffic</Text>
        </Group>
      }
      size="lg"
    >
      <Stack gap="sm">
        <Text size="sm">
          This captures HTTP(S) traffic from native <code>.exe</code> apps (not just Chrome) by
          running a local proxy. Enabling it will:
        </Text>
        <List size="sm" spacing={4}>
          <List.Item>
            Install a per-user root certificate (<b>no admin prompt</b>) so HTTPS can be decrypted.
          </List.Item>
          <List.Item>
            Point your Windows system proxy at <code>127.0.0.1:8888</code>. Your previous setting is
            saved and restored automatically when you turn this off or quit.
          </List.Item>
        </List>

        <Alert
          variant="light"
          color="yellow"
          icon={<IconAlertTriangle size={16} />}
          title="What won't be captured"
        >
          <List size="xs" spacing={2}>
            <List.Item>
              Apps with certificate pinning (e.g. Telegram, WhatsApp, most banking apps) — they
              reject the certificate.
            </List.Item>
            <List.Item>
              Apps that ignore the system proxy (some games, raw sockets, HTTP/3 over UDP).
            </List.Item>
          </List>
        </Alert>

        <Text size="xs" c="dimmed">
          Captured app requests appear in the same list as browser traffic, marked with a 🖥
          indicator, and export to HAR alongside them.
        </Text>

        <Group justify="flex-end" gap="xs" mt="xs">
          <Button variant="default" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            color="teal"
            onClick={enable}
            loading={busy}
            leftSection={<IconDeviceDesktop size={14} />}
          >
            Enable app capture
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
