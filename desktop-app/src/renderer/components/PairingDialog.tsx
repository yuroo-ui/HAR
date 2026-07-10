import { Button, CopyButton, Group, Modal, Stack, Text, TextInput } from '@mantine/core';

interface Props {
  token: string;
  onClose: () => void;
  onRegenerate: () => void;
}

export default function PairingDialog({ token, onClose, onRegenerate }: Props) {
  return (
    <Modal opened onClose={onClose} title="Pair extension with desktop" size="md">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          To prevent unauthorized clients on this machine from connecting to the local bridge, the
          extension must present this token. Open the extension popup → <b>Pairing</b> tab → paste
          this token → <b>Pair</b>.
        </Text>
        <TextInput
          label="Token"
          readOnly
          value={token}
          onFocus={(e) => e.currentTarget.select()}
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
        />
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onRegenerate}>
            Regenerate
          </Button>
          <CopyButton value={token}>
            {({ copied, copy }) => (
              <Button variant="light" onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
          </CopyButton>
          <Button onClick={onClose}>Done</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
