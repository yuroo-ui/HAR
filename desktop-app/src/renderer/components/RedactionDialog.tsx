import { useState } from 'react';
import { Button, Code, Group, Modal, Stack, Switch, Text, Textarea } from '@mantine/core';
import type { RedactionConfig } from '@har-suite/shared';

interface Props {
  initial: RedactionConfig;
  onClose: () => void;
  onSave: (cfg: RedactionConfig) => void;
}

export default function RedactionDialog({ initial, onClose, onSave }: Props) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [headerText, setHeaderText] = useState(initial.headerPatterns.join('\n'));
  const [bodyText, setBodyText] = useState(initial.bodyPatterns.join('\n'));

  const save = () => {
    onSave({
      enabled,
      headerPatterns: headerText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
      bodyPatterns: bodyText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    });
  };

  const mono = { input: { fontFamily: 'var(--mantine-font-family-monospace)' } };

  return (
    <Modal opened onClose={onClose} title="Sensitive data redaction" size="lg">
      <Stack gap="sm">
        <Text size="xs" c="dimmed">
          When enabled, matched values are replaced with <Code>&lt;redacted&gt;</Code> at export
          time. Captured data in memory is not modified.
        </Text>
        <Switch
          checked={enabled}
          onChange={(e) => setEnabled(e.currentTarget.checked)}
          label="Enable redaction at export"
        />
        <Textarea
          label="Header patterns (substring, case-insensitive)"
          value={headerText}
          onChange={(e) => setHeaderText(e.currentTarget.value)}
          autosize
          minRows={4}
          maxRows={8}
          styles={mono}
        />
        <Textarea
          label="JSON body keys to mask"
          value={bodyText}
          onChange={(e) => setBodyText(e.currentTarget.value)}
          autosize
          minRows={4}
          maxRows={8}
          styles={mono}
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
