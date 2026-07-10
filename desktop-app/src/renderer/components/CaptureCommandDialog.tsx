import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Code,
  CopyButton,
  Group,
  Modal,
  ScrollArea,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCopy,
  IconCheck,
  IconPlayerPlayFilled,
  IconPlayerStopFilled,
  IconTerminal2,
} from '@tabler/icons-react';

interface Props {
  onClose: () => void;
  globalActive: boolean;
  onSetGlobal: (enabled: boolean) => void;
}

type Line = { kind: 'stdout' | 'stderr' | 'meta'; text: string };

// Run a CLI/dev-tool with proxy + CA env injected into its process so its HTTP(S)
// traffic is captured. Also exposes the "Global" toggle that injects the same
// env into HKCU\Environment for every new shell.
export default function CaptureCommandDialog({ onClose, globalActive, onSetGlobal }: Props) {
  const [command, setCommand] = useState('');
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [envText, setEnvText] = useState('');
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.harSuite.getCliStatus().then((s) => {
      setRunning(s.commandRunning);
      setEnvText(s.envPreview ?? '');
    });
    const unsub = window.harSuite.onCommandOutput((out) => {
      if (out.stream === 'start') {
        setLines((p) => [...p, { kind: 'meta', text: `$ ${out.data}` }]);
        setRunning(true);
      } else if (out.stream === 'stdout') {
        setLines((p) => [...p, { kind: 'stdout', text: out.data }]);
      } else if (out.stream === 'stderr') {
        setLines((p) => [...p, { kind: 'stderr', text: out.data }]);
      } else if (out.stream === 'error') {
        setLines((p) => [...p, { kind: 'stderr', text: `[error] ${out.data}` }]);
        setRunning(false);
      } else if (out.stream === 'exit') {
        setLines((p) => [...p, { kind: 'meta', text: `[exited with code ${out.data}]` }]);
        setRunning(false);
      }
    });
    return () => {
      unsub();
    };
  }, []);

  // Auto-scroll the output pane as lines arrive.
  useEffect(() => {
    viewport.current?.scrollTo({ top: viewport.current.scrollHeight });
  }, [lines]);

  const run = async () => {
    if (!command.trim() || running) return;
    setLines([]);
    const res = await window.harSuite.runCommand(command.trim());
    if (!res.ok) {
      setLines([{ kind: 'stderr', text: res.error ?? 'Failed to start command' }]);
    }
  };

  const stop = () => window.harSuite.cancelCommand();

  return (
    <Modal
      opened
      onClose={onClose}
      size="xl"
      title={
        <Group gap={8}>
          <IconTerminal2 size={18} />
          <Text fw={600}>Capture CLI / dev-tool traffic</Text>
        </Group>
      }
    >
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Runs a command with proxy + certificate environment variables injected, so tools like{' '}
          <Code>claude</Code>, <Code>gemini</Code>, <Code>pip</Code>, <Code>curl</Code>, or{' '}
          <Code>go</Code> route through the capture proxy. Their requests appear in the list marked
          🖥.
        </Text>

        <Group gap="xs" wrap="nowrap" align="flex-end">
          <TextInput
            label="Command"
            placeholder="e.g. node -e &quot;fetch('https://example.com')&quot;  ·  claude  ·  pip install requests"
            style={{ flex: 1 }}
            value={command}
            onChange={(e) => setCommand(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !running) run();
            }}
            data-autofocus
          />
          {running ? (
            <Button color="red" leftSection={<IconPlayerStopFilled size={14} />} onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button
              color="teal"
              leftSection={<IconPlayerPlayFilled size={14} />}
              onClick={run}
              disabled={!command.trim()}
            >
              Run &amp; capture
            </Button>
          )}
        </Group>

        <ScrollArea h={240} viewportRef={viewport} className="cmd-output">
          {lines.length === 0 ? (
            <Text size="xs" c="dimmed" p="xs">
              Output will appear here…
            </Text>
          ) : (
            <pre className="cmd-pre">
              {lines.map((l, i) => (
                <span key={i} className={`cmd-${l.kind}`}>
                  {l.text}
                </span>
              ))}
            </pre>
          )}
        </ScrollArea>

        <Group justify="space-between" align="center">
          <Tooltip
            label="Inject the same env into your Windows user environment so every NEW terminal is captured automatically. Auto-restored when off."
            multiline
            w={300}
            withArrow
          >
            <Switch
              checked={globalActive}
              onChange={(e) => onSetGlobal(e.currentTarget.checked)}
              label="Capture all new terminals (global)"
            />
          </Tooltip>
          <CopyButton value={envText}>
            {({ copied, copy }) => (
              <Button
                variant="subtle"
                size="xs"
                color={copied ? 'teal' : 'gray'}
                leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                onClick={copy}
                disabled={!envText}
              >
                {copied ? 'Copied' : 'Copy env block'}
              </Button>
            )}
          </CopyButton>
        </Group>

        <Alert variant="light" color="gray" icon={<IconAlertTriangle size={16} />}>
          <Text size="xs">
            Won&apos;t capture cert-pinned clients. <b>Java</b> needs a manual step (import the CA
            with <Code>keytool</Code> into its truststore) — env vars alone don&apos;t cover the
            JVM.
          </Text>
        </Alert>
      </Stack>
    </Modal>
  );
}
