import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface SupervisedProcessRequest {
  key: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeout_ms: number;
  kill_grace_ms?: number;
  max_output_bytes?: number;
}

export interface SupervisedProcessResult {
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  cancelled: boolean;
  output_limit_exceeded: boolean;
  busy: boolean;
  spawn_error?: NodeJS.ErrnoException;
}

interface ActiveProcess {
  child: ChildProcessWithoutNullStreams;
  cancelled: boolean;
  force_kill_timer?: NodeJS.Timeout;
}

export class RuntimeProcessSupervisor {
  private readonly active = new Map<string, ActiveProcess>();

  run(request: SupervisedProcessRequest): Promise<SupervisedProcessResult> {
    const startedAt = Date.now();
    if (this.active.has(request.key)) {
      return Promise.resolve(emptyResult(Date.now() - startedAt, { busy: true }));
    }
    const maxOutputBytes = request.max_output_bytes ?? 4 * 1024 * 1024;
    const killGraceMs = request.kill_grace_ms ?? 750;

    return new Promise((resolve) => {
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let timedOut = false;
      let outputLimitExceeded = false;
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;

      const child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: request.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const active: ActiveProcess = { child, cancelled: false };
      this.active.set(request.key, active);

      const terminate = (): void => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        active.force_kill_timer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      };

      const finish = (
        partial: Pick<SupervisedProcessResult, "exit_code" | "signal"> & {
          spawn_error?: NodeJS.ErrnoException;
        }
      ): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (active.force_kill_timer) clearTimeout(active.force_kill_timer);
        if (this.active.get(request.key) === active) this.active.delete(request.key);
        resolve({
          ...partial,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          duration_ms: Date.now() - startedAt,
          timed_out: timedOut,
          cancelled: active.cancelled,
          output_limit_exceeded: outputLimitExceeded,
          busy: false,
        });
      };

      const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
        const used = stdout.length + stderr.length;
        const available = Math.max(0, maxOutputBytes - used);
        const accepted = chunk.subarray(0, available);
        if (stream === "stdout") stdout = Buffer.concat([stdout, accepted]);
        else stderr = Buffer.concat([stderr, accepted]);
        if (accepted.length < chunk.length && !outputLimitExceeded) {
          outputLimitExceeded = true;
          terminate();
        }
      };

      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.on("error", (error: NodeJS.ErrnoException) => {
        finish({ exit_code: null, signal: null, spawn_error: error });
      });
      child.on("close", (exitCode, signal) => finish({ exit_code: exitCode, signal }));

      if (request.stdin !== undefined) child.stdin.end(request.stdin, "utf8");
      else child.stdin.end();

      timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, request.timeout_ms);
    });
  }

  cancel(key: string): boolean {
    const active = this.active.get(key);
    if (!active) return false;
    active.cancelled = true;
    if (active.child.exitCode === null && active.child.signalCode === null) {
      active.child.kill("SIGTERM");
    }
    return true;
  }

  async close(key: string): Promise<void> {
    this.cancel(key);
  }
}

function emptyResult(
  durationMs: number,
  overrides: Partial<SupervisedProcessResult>
): SupervisedProcessResult {
  return {
    exit_code: null,
    signal: null,
    stdout: "",
    stderr: "",
    duration_ms: durationMs,
    timed_out: false,
    cancelled: false,
    output_limit_exceeded: false,
    busy: false,
    ...overrides,
  };
}
