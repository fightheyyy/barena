import { EvaluatorRunRequest, EvaluatorRunResult, EvaluatorRuntime, RuntimeProbeResult } from "../e2e/types";
import { runProcess } from "../runtime/process-runner";

export interface XiaoBaEvaluatorRuntimeConfig {
  command?: string;
  baseArgs?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export class XiaoBaEvaluatorRuntime implements EvaluatorRuntime {
  readonly id = "xiaoba-cli" as const;
  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(config: XiaoBaEvaluatorRuntimeConfig = {}) {
    this.command = config.command ?? "xiaoba";
    this.baseArgs = config.baseArgs ?? [];
    this.timeoutMs = config.timeoutMs ?? 5_000;
    this.maxOutputBytes = config.maxOutputBytes ?? 1024 * 1024;
  }

  async probe(): Promise<RuntimeProbeResult> {
    const version = await runProcess({
      command: this.command,
      args: [...this.baseArgs, "--version"],
      env: minimalEnv(),
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
    });
    if (version.spawnError) {
      return {
        component: "xiaoba-evaluator",
        status: "blocked",
        reason_code: version.spawnError.code === "ENOENT" ? "xiaoba_binary_not_found" : "xiaoba_cli_error",
        detail:
          version.spawnError.code === "ENOENT"
            ? "XiaobaOS CLI binary was not found on PATH."
            : `XiaobaOS CLI could not start (${version.spawnError.code ?? "unknown error"}).`,
        command: this.command,
        capabilities: [],
      };
    }
    if (version.timedOut || version.outputLimitExceeded || version.exitCode !== 0) {
      return {
        component: "xiaoba-evaluator",
        status: "blocked",
        reason_code: "xiaoba_cli_error",
        detail: "XiaobaOS CLI version preflight did not complete successfully.",
        command: this.command,
        capabilities: [],
      };
    }

    const help = await runProcess({
      command: this.command,
      args: [...this.baseArgs, "arena", "run", "execute", "--help"],
      env: minimalEnv(),
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
    });
    const helpText = `${help.stdout}\n${help.stderr}`;
    const capabilities = [
      ...(helpText.includes("--mode") ? ["arena_execute"] : []),
      ...(supportsAgentMode(helpText) ? ["external_agent_mode"] : []),
      ...(helpText.includes("--target-driver-manifest") ? ["target_driver_manifest"] : []),
    ];

    if (help.spawnError || help.timedOut || help.outputLimitExceeded || help.exitCode !== 0) {
      return {
        component: "xiaoba-evaluator",
        status: "blocked",
        reason_code: "xiaoba_cli_error",
        detail: "XiaobaOS Arena execute preflight failed.",
        command: this.command,
        version: normalizedVersion(version.stdout, version.stderr),
        capabilities,
      };
    }

    if (!capabilities.includes("external_agent_mode") || !capabilities.includes("target_driver_manifest")) {
      return {
        component: "xiaoba-evaluator",
        status: "blocked",
        reason_code: "xiaoba_external_agent_mode_unavailable",
        detail: "Installed XiaobaOS Arena supports Skill/Role subjects but not the required external-agent target driver.",
        command: this.command,
        version: normalizedVersion(version.stdout, version.stderr),
        capabilities,
      };
    }

    return {
      component: "xiaoba-evaluator",
      status: "ready",
      detail: "XiaobaOS Arena exposes external-agent mode and a target-driver manifest contract.",
      command: this.command,
      version: normalizedVersion(version.stdout, version.stderr),
      capabilities,
    };
  }

  async runCase(_request: EvaluatorRunRequest): Promise<EvaluatorRunResult> {
    return {
      status: "blocked",
      reason_code: "xiaoba_external_agent_driver_unimplemented",
      detail:
        "XiaobaOS advertises an external-agent contract, but Barena's legacy target-driver bridge has not been implemented for that protocol.",
      stages: {
        usercat: "blocked",
        inspectorcat: "blocked",
        reviewercat: "blocked",
      },
      attempts: [],
      evaluator_trace_refs: [],
    };
  }
}

function supportsAgentMode(help: string): boolean {
  return /(?:--mode[^\n]*(?:^|[\s|,])agent(?:[\s|,)]|$))|(?:agent[^\n]*subject)/im.test(help);
}

function minimalEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    NO_COLOR: "1",
    CI: "1",
  };
}

function normalizedVersion(stdout: string, stderr: string): string | undefined {
  const lines = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1];
}
