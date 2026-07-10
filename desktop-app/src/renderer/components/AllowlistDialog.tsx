import { useState } from 'react';
import { Button, Code, Group, Modal, Stack, Text, Textarea } from '@mantine/core';

interface Props {
  initial: string[];
  onClose: () => void;
  onSave: (domains: string[]) => void;
}

export default function AllowlistDialog({ initial, onClose, onSave }: Props) {
  const [text, setText] = useState(initial.join('\n'));

  const save = () => {
    const domains = text
      .split(/\r?\n/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    onSave(domains);
  };

  return (
    <Modal opened onClose={onClose} title="Allowlist domains" size="lg">
      <Stack gap="sm">
        <Text size="xs" c="dimmed">
          One domain per line. Subdomains are auto-included. Example: <Code>api.example.com</Code>{' '}
          matches <Code>api.example.com</Code> and <Code>v2.api.example.com</Code>. A matched tab
          keeps capturing across domain changes (flow capture).
        </Text>
        <Textarea
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          placeholder={'example.com\napi.target.com'}
          autosize
          minRows={8}
          maxRows={16}
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
        />
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save}>Save</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
