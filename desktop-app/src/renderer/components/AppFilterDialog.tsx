import { useEffect, useState } from 'react';
import { Badge, Button, Group, Modal, Stack, Switch, Text, Textarea } from '@mantine/core';

interface Props {
  initial: { exeNames: string[]; bypass: boolean };
  onClose: () => void;
  onSave: (data: { exeNames: string[]; bypass: boolean }) => void;
}

export default function AppFilterDialog({ initial, onClose, onSave }: Props) {
  const [exeNames, setExeNames] = useState(initial.exeNames.join('\n'));
  const [bypass, setBypass] = useState(initial.bypass);
  const [seenExes, setSeenExes] = useState<string[]>([]);
  const [runningProcesses, setRunningProcesses] = useState<string[]>([]);
  const [showAllProcesses, setShowAllProcesses] = useState(false);

  useEffect(() => {
    window.harSuite.getAppFilter().then((data) => {
      setSeenExes(data.seenExes);
      setRunningProcesses(data.runningProcesses || []);
    });
  }, []);

  const save = () => {
    const exeList = exeNames
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    onSave({ exeNames: exeList, bypass });
  };

  const addSeenExe = (exe: string) => {
    const current = exeNames.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!current.includes(exe)) {
      setExeNames([...current, exe].join('\n'));
    }
  };

  const addRunningProcess = (exe: string) => {
    const current = exeNames.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!current.includes(exe)) {
      setExeNames([...current, exe].join('\n'));
    }
  };

  return (
    <Modal opened onClose={onClose} title="App filter" size="lg">
      <Stack gap="md">
        <Text size="xs" c="dimmed">
          One .exe name per line. Only traffic from matching processes will be captured. Leave empty
          to capture all apps.
        </Text>
        <Textarea
          value={exeNames}
          onChange={(e) => setExeNames(e.currentTarget.value)}
          placeholder={'node.exe\nclaude.exe\ngemini.exe'}
          autosize
          minRows={6}
          maxRows={12}
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
        />
        <Switch
          checked={bypass}
          onChange={(e) => setBypass(e.currentTarget.checked)}
          label="Capture all apps (bypass filter)"
        />
        {seenExes.length > 0 && (
          <Stack gap="xs">
            <Text size="xs" c="dimmed">
              Recently seen processes (click to add):
            </Text>
            <Group gap="xs">
              {seenExes.map((exe) => (
                <Badge
                  key={exe}
                  variant="light"
                  style={{ cursor: 'pointer' }}
                  onClick={() => addSeenExe(exe)}
                >
                  {exe}
                </Badge>
              ))}
            </Group>
          </Stack>
        )}
        {runningProcesses.length > 0 && (
          <Stack gap="xs">
            <Group justify="space-between">
              <Text size="xs" c="dimmed">
                All running processes (click to add):
              </Text>
              <Button
                size="xs"
                variant="subtle"
                onClick={() => setShowAllProcesses(!showAllProcesses)}
              >
                {showAllProcesses ? 'Hide' : 'Show'} ({runningProcesses.length})
              </Button>
            </Group>
            {showAllProcesses && (
              <Group gap="xs">
                {runningProcesses.map((exe) => (
                  <Badge
                    key={exe}
                    variant="outline"
                    style={{ cursor: 'pointer' }}
                    onClick={() => addRunningProcess(exe)}
                  >
                    {exe}
                  </Badge>
                ))}
              </Group>
            )}
          </Stack>
        )}
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
