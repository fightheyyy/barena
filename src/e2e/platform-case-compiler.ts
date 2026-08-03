import { validateExploreScenario } from "../explore/scenario";
import type { ExploreScenarioV1 } from "../explore/types";
import type { StructuredArtifactAssertion } from "../verifier/artifact-verifier";
import { validateAgentE2ECase } from "./case-runner";
import type { AgentE2ECaseV1 } from "./types";

export interface PlatformCaseV1 {
  schema: "barena.case.v1";
  case_id: string;
  revision: 1;
  source_issue_id: string;
  source_run_id: string;
  source_trace_id?: string;
  title: string;
  operation: "explore";
  input: {
    scenario: ExploreScenarioV1;
  };
  runtime?: Record<string, unknown>;
  success_criteria: string;
  replay_prompt?: string;
  verifier: {
    kind: "artifact_assertions";
    artifacts: StructuredArtifactAssertion[];
  };
  created_at: string;
}

export class PlatformCaseCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformCaseCompileError";
  }
}

/**
 * Compiles the reviewed Platform Case into the one canonical Replay Case.
 *
 * This boundary intentionally supports only XiaoBaOS Explore Cases whose
 * deterministic verifier can be represented by the existing artifact
 * assertions. Unsupported source behavior is rejected instead of being
 * approximated by another runner or evaluator.
 */
export function compilePlatformCaseForReplay(
  value: unknown
): AgentE2ECaseV1 {
  const platformCase = record(value, "Platform Case");
  if (platformCase.schema !== "barena.case.v1") {
    throw new PlatformCaseCompileError(
      "Platform Case schema must be barena.case.v1"
    );
  }

  const caseId = safeId(platformCase.case_id, "Platform Case case_id");
  if (platformCase.revision !== 1) {
    throw new PlatformCaseCompileError(
      "Platform Case revision must be 1 for the current replay compiler"
    );
  }
  safeId(platformCase.source_issue_id, "Platform Case source_issue_id");
  safeId(platformCase.source_run_id, "Platform Case source_run_id");
  if (platformCase.source_trace_id !== undefined) {
    nonEmptyString(
      platformCase.source_trace_id,
      "Platform Case source_trace_id",
      256
    );
  }
  nonEmptyString(platformCase.title, "Platform Case title", 160);
  nonEmptyString(
    platformCase.success_criteria,
    "Platform Case success_criteria",
    4_000
  );
  timestamp(platformCase.created_at, "Platform Case created_at");

  if (platformCase.operation !== "explore") {
    throw new PlatformCaseCompileError(
      "Platform Case operation must be explore for XiaoBaOS MVP1 replay"
    );
  }

  const input = record(platformCase.input, "Platform Case input");
  const verifier = record(platformCase.verifier, "Platform Case verifier");
  if (verifier.kind !== "artifact_assertions") {
    throw new PlatformCaseCompileError(
      "Platform Case verifier.kind must be artifact_assertions"
    );
  }
  if (!Array.isArray(verifier.artifacts) || verifier.artifacts.length === 0) {
    throw new PlatformCaseCompileError(
      "Platform Case verifier.artifacts must be a non-empty array"
    );
  }

  const artifacts = cloneArtifacts(verifier.artifacts);
  const compiled = input.schema === "barena.platform_explore_scenario.v1"
    ? compilePlatformHttpCase(platformCase, input, caseId, artifacts)
    : compileXiaobaPlatformCase(platformCase, input, caseId, artifacts);

  try {
    validateAgentE2ECase(compiled);
  } catch (error) {
    throw new PlatformCaseCompileError(
      `Platform Case verifier cannot compile to barena.agent_e2e_case.v1: ${errorMessage(error)}`
    );
  }
  return compiled;
}

function compileXiaobaPlatformCase(
  platformCase: Record<string, unknown>,
  input: Record<string, unknown>,
  caseId: string,
  artifacts: StructuredArtifactAssertion[]
): AgentE2ECaseV1 {
  let scenario: ExploreScenarioV1;
  try {
    scenario = validateExploreScenario(input.scenario);
  } catch (error) {
    throw new PlatformCaseCompileError(
      `Platform Case input.scenario is invalid: ${errorMessage(error)}`
    );
  }
  if (scenario.target.runtime !== "xiaobaos") {
    throw new PlatformCaseCompileError(
      `Unsupported Platform Case Runtime: ${scenario.target.runtime}`
    );
  }
  if (scenario.target.skill) {
    throw new PlatformCaseCompileError(
      "Platform Case replay does not support source Explore target.skill; a reviewed fixed Case must not silently change Skill activation"
    );
  }
  validateRuntimeSnapshot(platformCase.runtime, scenario);
  const replayPrompt = platformCase.replay_prompt === undefined
    ? scenario.objective
    : nonEmptyString(platformCase.replay_prompt, "Platform Case replay_prompt", 24_000);
  return {
    schema: "barena.agent_e2e_case.v1",
    case_id: caseId,
    target: {
      adapter: "xiaoba",
      runtime: "xiaobaos",
      agent: scenario.target.role,
      ...(scenario.target.model && { model: scenario.target.model }),
      env_allowlist: [...(scenario.target.env_allowlist ?? [])],
    },
    task: {
      prompt: replayPrompt,
    },
    assertions: {
      artifacts,
    },
    timeout_ms: scenario.timeout_ms,
    isolation: {
      level: scenario.isolation.level,
      network: scenario.isolation.network,
      writable_roots: ["workspace"],
    },
  };
}

function compilePlatformHttpCase(
  platformCase: Record<string, unknown>,
  input: Record<string, unknown>,
  caseId: string,
  artifacts: StructuredArtifactAssertion[]
): AgentE2ECaseV1 {
  const scenario = record(input.scenario, "Platform HTTP Case input.scenario");
  const objective = nonEmptyString(
    scenario.objective,
    "Platform HTTP Case scenario.objective",
    24_000
  );
  nonEmptyString(scenario.name, "Platform HTTP Case scenario.name", 300);
  if (
    !Array.isArray(scenario.criteria) ||
    scenario.criteria.length > 100 ||
    !scenario.criteria.every(
      (criterion) =>
        typeof criterion === "string" &&
        criterion.trim().length > 0 &&
        criterion.length <= 4_000
    )
  ) {
    throw new PlatformCaseCompileError(
      "Platform HTTP Case scenario.criteria must be a bounded string array"
    );
  }
  const target = record(input.target, "Platform HTTP Case input.target");
  if (target.type !== "http") {
    throw new PlatformCaseCompileError(
      "Platform HTTP Case target.type must be http"
    );
  }
  const targetReference = nonEmptyString(
    target.reference_id,
    "Platform HTTP Case target.reference_id",
    256
  );
  nonEmptyString(target.name, "Platform HTTP Case target.name", 300);

  const runtime = record(platformCase.runtime, "Platform HTTP Case runtime");
  exactKeys(
    runtime,
    ["schema", "type", "reference_id", "name", "replay"],
    "Platform HTTP Case runtime"
  );
  if (
    runtime.schema !== "barena.platform_http_runtime.v1" ||
    runtime.type !== "http" ||
    runtime.reference_id !== targetReference
  ) {
    throw new PlatformCaseCompileError(
      "Platform HTTP Case runtime identity does not match its adopted target"
    );
  }
  const replay = record(runtime.replay, "Platform HTTP Case runtime.replay");
  exactKeys(
    replay,
    ["supported", "reason", "url", "method", "output_path", "timeout_ms"],
    "Platform HTTP Case runtime.replay"
  );
  if (replay.supported !== true) {
    const reason = typeof replay.reason === "string" && replay.reason.trim()
      ? replay.reason.trim()
      : "this HTTP Agent does not satisfy the no-secret standard Replay contract";
    throw new PlatformCaseCompileError(`HTTP Replay is unavailable: ${reason}`);
  }
  if (replay.reason !== undefined && replay.reason !== "") {
    throw new PlatformCaseCompileError(
      "A replay-supported HTTP runtime cannot include a failure reason"
    );
  }
  const url = nonEmptyString(replay.url, "Platform HTTP Case replay.url", 2_048);
  if (replay.method !== "POST") {
    throw new PlatformCaseCompileError("Platform HTTP Case replay.method must be POST");
  }
  const timeoutMs = integerInRange(
    replay.timeout_ms,
    "Platform HTTP Case replay.timeout_ms",
    1_000,
    120_000
  );
  const supportedOutputPaths = [
    "$.response",
    "$.message",
    "$.content",
    "$.choices[0].message.content",
  ] as const;
  if (
    replay.output_path !== undefined &&
    replay.output_path !== "" &&
    !supportedOutputPaths.includes(
      replay.output_path as (typeof supportedOutputPaths)[number]
    )
  ) {
    throw new PlatformCaseCompileError(
      "Platform HTTP Case replay.output_path is unsupported"
    );
  }
  const replayPrompt = platformCase.replay_prompt === undefined
    ? objective
    : nonEmptyString(platformCase.replay_prompt, "Platform Case replay_prompt", 24_000);
  return {
    schema: "barena.agent_e2e_case.v1",
    case_id: caseId,
    target: {
      adapter: "http",
      runtime: "http",
      agent: targetReference,
      http: {
        url,
        method: "POST",
        ...(typeof replay.output_path === "string" && replay.output_path !== "" && {
          output_path: replay.output_path as (typeof supportedOutputPaths)[number],
        }),
        timeout_ms: timeoutMs,
      },
    },
    task: { prompt: replayPrompt },
    assertions: { artifacts },
    timeout_ms: timeoutMs,
    isolation: {
      level: "policy_only",
      network: "unrestricted",
      writable_roots: ["workspace"],
    },
  };
}

function validateRuntimeSnapshot(
  value: unknown,
  scenario: ExploreScenarioV1
): void {
  if (value === undefined) return;
  const runtime = record(value, "Platform Case runtime");
  for (const identity of [runtime.runtime, runtime.name]) {
    if (identity !== undefined && identity !== scenario.target.runtime) {
      throw new PlatformCaseCompileError(
        `Unsupported Platform Case Runtime: ${String(identity)}`
      );
    }
  }
  if (runtime.role !== undefined && runtime.role !== scenario.target.role) {
    throw new PlatformCaseCompileError(
      "Platform Case runtime.role must match input.scenario.target.role"
    );
  }
  if (runtime.skill !== undefined) {
    throw new PlatformCaseCompileError(
      "Platform Case runtime.skill is unsupported by fixed Replay"
    );
  }
}

function cloneArtifacts(value: unknown[]): StructuredArtifactAssertion[] {
  try {
    return JSON.parse(JSON.stringify(value)) as StructuredArtifactAssertion[];
  } catch (error) {
    throw new PlatformCaseCompileError(
      `Platform Case verifier.artifacts must be JSON-serializable: ${errorMessage(error)}`
    );
  }
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string
): void {
  const unsupported = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unsupported.length > 0) {
    throw new PlatformCaseCompileError(
      `${label} contains unsupported fields: ${unsupported.sort().join(", ")}`
    );
  }
}

function integerInRange(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new PlatformCaseCompileError(
      `${label} must be an integer from ${minimum} to ${maximum}`
    );
  }
  return value as number;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlatformCaseCompileError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function safeId(value: unknown, label: string): string {
  const text = nonEmptyString(value, label, 120);
  if (!/^[A-Za-z0-9._-]+$/.test(text) || text === "." || text === "..") {
    throw new PlatformCaseCompileError(`${label} must be a safe identifier`);
  }
  return text;
}

function nonEmptyString(
  value: unknown,
  label: string,
  maxLength: number
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maxLength
  ) {
    throw new PlatformCaseCompileError(
      `${label} must be a non-empty string of at most ${maxLength} characters`
    );
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const text = nonEmptyString(value, label, 64);
  if (!Number.isFinite(Date.parse(text))) {
    throw new PlatformCaseCompileError(`${label} must be an ISO timestamp`);
  }
  return text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
