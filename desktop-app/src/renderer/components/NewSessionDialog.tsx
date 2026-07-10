import { useState } from 'react';
import { Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';

interface Props {
  defaultName: string;
  onClose: () => void;
  onCreate: (name: string) => void;
}

// Electron renderers do NOT support window.prompt() (it returns "" and warns),
// which is why the old "New session" button silently did nothing. This modal
// replaces it.
export default function NewSessionDialog({ defaultName, onClose, onCreate }: Props) {
  const [name, setName] = useState(defaultName);

  const submit = () => onCreate(name.trim() || defaultName);

  return (
    <Modal opened onClose={onClose} title="New session" size="md">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Starts a fresh capture. The current session is saved and stays in the sidebar.
        </Text>
        <TextInput
          data-autofocus
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder="Session name"
        />
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit}>Create</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
