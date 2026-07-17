import { spawn } from "node:child_process";

export interface ProcessRunRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  killGraceMs?: number;
  maxOutputBytes?: number;
}

export interface ProcessRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  spawnError?: NodeJS.ErrnoException;
}

export function runProcess(request: ProcessRunRequest): Promise<ProcessRunResult> {
  const startedAt = Date.now();
  const maxOutputBytes = request.maxOutputBytes ?? 1024 * 1024;
  const killGraceMs = request.killGraceMs ?? 500;

  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
    }, request.timeoutMs);

    const finish = (result: Omit<ProcessRunResult, "stdout" | "stderr" | "durationMs" | "timedOut" | "outputLimitExceeded">): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      resolve({
        ...result,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        durationMs: Date.now() - startedAt,
        timedOut,
        outputLimitExceeded,
      });
    };

    const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      const used = stdout.length + stderr.length;
      const available = Math.max(0, maxOutputBytes - used);
      const accepted = chunk.subarray(0, available);
      if (stream === "stdout") {
        stdout = Buffer.concat([stdout, accepted]);
      } else {
        stderr = Buffer.concat([stderr, accepted]);
      }
      if (accepted.length < chunk.length && !outputLimitExceeded) {
        outputLimitExceeded = true;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ exitCode: null, signal: null, spawnError: error });
    });
    child.on("close", (exitCode, signal) => {
      finish({ exitCode, signal });
    });
  });
}
