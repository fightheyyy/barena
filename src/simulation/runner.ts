import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { boundaryEvent, writeBoundaryEvents } from "../e2e/boundary-trace";
import type { RuntimeMessage, RuntimeTurnResult } from "../runtime-adapters";
import { ensureDir, writeJson } from "../utils/fs";
import { validateAgentSimulationCase } from "./case-loader";
import type {
  AgentSimulationAssertionResult,
  AgentSimulationCaseV1,
  AgentSimulationResultV1,
  AgentSimulationRunOptions,
  AgentSimulationTurnResult,
  AgentSimulationTurnWindow,
} from "./types";
import {
  createSimulationTraceContext,
  createSimulationTurnTraceparent,
  exportSimulationObservation,
} from "./otlp-observer";

export async function runAgentSimulationCase(
  caseDefinition: AgentSimulationCaseV1,
  options: AgentSimulationRunOptions
): Promise<AgentSimulationResultV1> {
  validateAgentSimulationCase(caseDefinition);
  const now = options.now ?? (() => new Date());
  const createdAt = now();
  const startedAt = new Date();
  const runId = createRunId(createdAt);
  const runRoot = path.resolve(options.runsRoot ?? "runs", runId);
  const workspace = path.join(runRoot, "workspace");
  const boundaryTrace = path.join(runRoot, "traces", "boundary.ndjson");
  const resultPath = path.join(runRoot, "reviewer", "simulation-scorecard.json");
  for (const directory of [
    runRoot,
    workspace,
    path.dirname(boundaryTrace),
    path.dirname(resultPath),
    path.join(runRoot, "reports"),
  ]) ensureDir(directory);
  writeJson(path.join(runRoot, "case.json"), caseDefinition);

  const role = caseDefinition.target.role ?? "base";
  const probe = await options.adapter.probe({ required_targets: [role] });
  const baseResult = {
    schema: "barena.agent_simulation_result.v1" as const,
    run_id: runId,
    case_id: caseDefinition.case_id,
    created_at: createdAt.toISOString(),
    source: caseDefinition.source,
    target: {
      adapter: caseDefinition.target.adapter,
      requested_model: caseDefinition.target.model,
      probe,
      session_mode: options.adapter.capabilities.session_mode,
    },
    evidence: {
      boundary_trace: boundaryTrace,
      native_trace_collected: false,
      telemetry_configured: Boolean(options.telemetry),
    },
    workspace,
  };

  const traceContext = options.telemetry
    ? createSimulationTraceContext(options.telemetry.traceparent)
    : undefined;
  const threadId = `${runId}-${caseDefinition.case_id}`;
  const turnWindows: AgentSimulationTurnWindow[] = [];
  const finish = async (result: AgentSimulationResultV1): Promise<AgentSimulationResultV1> => {
    writeResult(runRoot, result);
    if (options.telemetry && traceContext) {
      result.evidence.catena_observation = await exportSimulationObservation({
        telemetry: options.telemetry,
        context: traceContext,
        caseDefinition,
        result,
        threadId,
        startedAt,
        endedAt: new Date(),
        turnWindows,
      });
      writeResult(runRoot, result);
    }
    return result;
  };

  if (probe.status === "blocked") {
    return finish({
      ...baseResult,
      status: "blocked",
      reason_code: probe.reason_code,
      summary: probe.detail,
      turns: [],
      assertions: [],
    });
  }

  const session = await options.adapter.openSession({
    run_id: runId,
    scenario_id: caseDefinition.case_id,
    attempt_id: "simulation",
    session_id: `${runId}-target`,
    thread_id: threadId,
    workspace,
    target: {
      role,
      model: caseDefinition.target.model,
      skill: caseDefinition.target.skill,
      env_allowlist: caseDefinition.target.env_allowlist,
    },
  });
  const turns: AgentSimulationTurnResult[] = [];
  let terminalFailure: RuntimeTurnResult | undefined;
  try {
    for (let index = 0; index < caseDefinition.turns.length; index += 1) {
      const turnStartedAt = new Date();
      const scripted = caseDefinition.turns[index];
      const telemetry = options.telemetry && traceContext
        ? {
            ...options.telemetry,
            traceparent: createSimulationTurnTraceparent(traceContext, runId, index + 1),
          }
        : options.telemetry;
      writeBoundaryEvents(boundaryTrace, [boundaryEvent({
        runId,
        caseId: caseDefinition.case_id,
        attemptId: `turn-${index + 1}`,
        component: options.adapter.id,
        observedFrom: "target_input",
        kind: "user",
        message: scripted.user,
        data: { thread_id: threadId, turn: index + 1 },
      })]);

      const result = await options.adapter.sendTurn(session, {
        message: scripted.user,
        timeout_ms: caseDefinition.timeout_ms,
        telemetry,
      });
      const assistant: RuntimeMessage[] = result.assistant ? [result.assistant] : [];
      turns.push({
        turn: index + 1,
        user: scripted.user,
        assistant,
        status: result.status,
        reason_code: result.reason_code,
        detail: result.detail,
        process: {
          exit_code: result.process.exit_code,
          signal: result.process.signal,
          duration_ms: result.process.duration_ms,
        },
      });
      turnWindows.push({ turn: index + 1, startedAt: turnStartedAt, endedAt: new Date() });
      if (result.native_trace_refs.length > 0) baseResult.evidence.native_trace_collected = true;
      writeBoundaryEvents(boundaryTrace, [
        ...assistant.map((message) => boundaryEvent({
          runId,
          caseId: caseDefinition.case_id,
          attemptId: `turn-${index + 1}`,
          component: options.adapter.id,
          observedFrom: "target_stdout" as const,
          kind: "assistant" as const,
          message: message.content,
          data: { thread_id: threadId, turn: index + 1 },
        })),
        boundaryEvent({
          runId,
          caseId: caseDefinition.case_id,
          attemptId: `turn-${index + 1}`,
          component: options.adapter.id,
          observedFrom: "target_process",
          kind: "runtime_status",
          message: result.detail,
          data: {
            thread_id: threadId,
            turn: index + 1,
            status: result.status,
            reason_code: result.reason_code,
            duration_ms: result.process.duration_ms,
            session_mode: options.adapter.capabilities.session_mode,
            telemetry_configured: result.telemetry.configured,
            native_trace_collected: result.native_trace_refs.length > 0,
          },
        }),
      ]);
      if (result.status !== "completed") {
        terminalFailure = result;
        break;
      }
    }
  } finally {
    await options.adapter.close(session);
  }

  if (terminalFailure) {
    return finish({
      ...baseResult,
      status: terminalFailure.status === "failed" ? "fail" : "blocked",
      reason_code: terminalFailure.reason_code,
      summary: terminalFailure.detail,
      turns,
      assertions: [],
    });
  }

  const finalResponse = [...turns]
    .reverse()
    .flatMap((turn) => turn.assistant)
    .find((message) => message.role === "assistant")?.content ?? "";
  const assertions = evaluateFinalResponse(caseDefinition, finalResponse);
  const passed = assertions.length > 0 && assertions.every((assertion) => assertion.status === "pass");
  return finish({
    ...baseResult,
    status: passed ? "pass" : "fail",
    ...(passed ? {} : { reason_code: "simulation_assertion_failed" }),
    summary: passed
      ? `Completed ${turns.length} scripted turns and passed all final-response assertions.`
      : `Completed ${turns.length} scripted turns but failed one or more final-response assertions.`,
    turns,
    assertions,
  });
}

function evaluateFinalResponse(
  caseDefinition: AgentSimulationCaseV1,
  response: string
): AgentSimulationAssertionResult[] {
  const definition = caseDefinition.assertions.final_response;
  const normalize = (value: string): string => definition.case_sensitive
    ? value
    : value.toLocaleLowerCase();
  const actual = normalize(response);
  const includes = (expected: string): boolean => actual.includes(normalize(expected));
  const results: AgentSimulationAssertionResult[] = [];
  if (definition.contains_all?.length) {
    const missing = definition.contains_all.filter((value) => !includes(value));
    results.push({
      kind: "contains_all",
      status: missing.length === 0 ? "pass" : "fail",
      expected: definition.contains_all,
      detail: missing.length === 0
        ? "Final response contained every required value."
        : `Missing: ${missing.join(", ")}`,
    });
  }
  if (definition.contains_any?.length) {
    const matched = definition.contains_any.filter(includes);
    results.push({
      kind: "contains_any",
      status: matched.length > 0 ? "pass" : "fail",
      expected: definition.contains_any,
      detail: matched.length > 0
        ? `Matched: ${matched.join(", ")}`
        : "Final response contained none of the accepted values.",
    });
  }
  if (definition.excludes?.length) {
    const present = definition.excludes.filter(includes);
    results.push({
      kind: "excludes",
      status: present.length === 0 ? "pass" : "fail",
      expected: definition.excludes,
      detail: present.length === 0
        ? "Final response excluded every forbidden value."
        : `Unexpected: ${present.join(", ")}`,
    });
  }
  return results;
}

function writeResult(runRoot: string, result: AgentSimulationResultV1): void {
  writeJson(path.join(runRoot, "reviewer", "simulation-scorecard.json"), result);
  writeJson(path.join(runRoot, "reports", "report.json"), result);
  fs.writeFileSync(path.join(runRoot, "reports", "report.md"), renderReport(result), "utf8");
}

function renderReport(result: AgentSimulationResultV1): string {
  return [
    `# Barena Agent Simulation: ${result.case_id}`,
    "",
    `- Status: ${result.status}`,
    `- Target: ${result.target.adapter} (${result.target.probe.status})`,
    `- Requested model: ${result.target.requested_model ?? "not specified"}`,
    `- Session mode: ${result.target.session_mode}`,
    `- Turns: ${result.turns.length}`,
    `- Native trace collected: ${result.evidence.native_trace_collected}`,
    `- Source: ${result.source.project} @ ${result.source.commit}`,
    "",
    result.summary,
    "",
  ].join("\n");
}

function createRunId(now: Date): string {
  const timestamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `agent-simulation-${timestamp}-${crypto.randomBytes(3).toString("hex")}`;
}
