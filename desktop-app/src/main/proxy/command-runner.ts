import { spawn, type ChildProcess } from 'node:child_process';

export interface CommandOutput {
  // 'stdout' | 'stderr' lines as they stream; 'exit' carries the exit code;
  // 'error' carries a spawn failure (e.g. command not found).
  stream: 'stdout' | 'stderr' | 'exit' | 'error' | 'start';
  data: string;
}

/**
 * Spawns a shell command with capture env vars injected into ITS process only,
 * so its HTTP(S) traffic routes through our proxy and trusts our CA — without
 * touching the rest of the system. Streams output back via `onOutput`.
 *
 * Only one command runs at a time; starting a new one is rejected while another
 * is live (the caller surfaces that). The injected env is layered over the
 * app's own environment so the command still finds PATH, etc.
 */
export class CommandRunner {
  private child: ChildProcess | null = null;

  isRunning(): boolean {
    return this.child !== null;
  }

  run(
    command: string,
    captureEnv: Record<string, string>,
    onOutput: (out: CommandOutput) => void,
    cwd?: string,
  ): { ok: boolean; error?: string } {
    if (this.child) return { ok: false, error: 'A command is already running.' };
    const cmd = command.trim();
    if (!cmd) return { ok: false, error: 'Empty command.' };

    let child: ChildProcess;
    try {
      child = spawn(cmd, {
        shell: true,
        cwd: cwd || undefined,
        env: { ...process.env, ...captureEnv },
        windowsHide: true,
      });
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }

    this.child = child;
    onOutput({ stream: 'start', data: cmd });

    child.stdout?.on('data', (b: Buffer) => onOutput({ stream: 'stdout', data: b.toString() }));
    child.stderr?.on('data', (b: Buffer) => onOutput({ stream: 'stderr', data: b.toString() }));
    child.on('error', (err) => {
      onOutput({ stream: 'error', data: String(err?.message ?? err) });
      this.child = null;
    });
    child.on('close', (code) => {
      onOutput({ stream: 'exit', data: String(code ?? 0) });
      this.child = null;
    });

    return { ok: true };
  }

  /** Terminate the running command, if any. Idempotent. */
  cancel(): void {
    const c = this.child;
    if (!c) return;
    try {
      // On Windows, killing the shell doesn't always kill grandchildren; taskkill
      // by PID tree is the reliable path.
      if (process.platform === 'win32' && c.pid != null) {
        spawn('taskkill', ['/pid', String(c.pid), '/t', '/f'], { windowsHide: true });
      } else {
        c.kill('SIGTERM');
      }
    } catch {
      // Best-effort.
    }
    this.child = null;
  }
}
