import type { EvaluatorRunRequest, EvaluatorRunResult, EvaluatorRuntime, RuntimeProbeResult } from "../e2e/types";

export interface XiaoBaEvaluatorRuntimeConfig {
  command?: string;
  baseArgs?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * @deprecated XiaobaOS is a Barena target, not Barena's evaluator runtime.
 * Kept as a fail-closed source-compatibility shim for 0.1 callers.
 */
export class XiaoBaEvaluatorRuntime implements EvaluatorRuntime {
  readonly id = "xiaoba-cli" as const;
  private readonly command: string;

  constructor(config: XiaoBaEvaluatorRuntimeConfig = {}) {
    this.command = config.command ?? "xiaoba";
  }

  async probe(): Promise<RuntimeProbeResult> {
    return {
      component: "xiaoba-evaluator",
      status: "blocked",
      reason_code: "xiaoba_external_agent_mode_unavailable",
      detail: "XiaobaOS evaluator mode was removed: Barena owns evaluation and invokes XiaobaOS only as an ordinary chat target.",
      command: this.command,
      capabilities: [],
    };
  }

  async runCase(_request: EvaluatorRunRequest): Promise<EvaluatorRunResult> {
    return {
      status: "blocked",
      reason_code: "xiaoba_external_agent_driver_unimplemented",
      detail: "XiaobaOS evaluator mode is unavailable; use XiaobaTargetAdapter with BarenaPortableEvaluatorRuntime.",
      stages: { usercat: "blocked", inspectorcat: "blocked", reviewercat: "blocked" },
      attempts: [],
      evaluator_trace_refs: [],
    };
  }
}
