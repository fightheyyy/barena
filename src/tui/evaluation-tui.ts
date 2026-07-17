import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { loadAgentE2ECase } from "../e2e/case-runner";
import { BoundaryTraceEvent } from "../e2e/types";
import { loadSkillSelection, runSkillEvaluation } from "../evaluation/run-skill-evaluation";
import {
  createXiaoBaNativeRoleRequest,
  createXiaoBaNativeSkillRequest,
  loadXiaoBaNativeCase,
} from "../evaluation/xiaoba-native-input";
import { runXiaoBaNativeEvaluation } from "../evaluation/xiaoba-native-runner";
import { XiaoBaNativeAttemptResult } from "../evaluation/xiaoba-native-types";
import { readJson, readNdjson } from "../utils/fs";
import {
  AnyEvaluationResult,
  EvaluationTuiAction,
  EvaluationTuiEffect,
  EvaluationTuiState,
  PreviousEvaluation,
  TraceViewEvent,
  initialEvaluationTuiState,
  reduceEvaluationTui,
} from "./evaluation-model";
import { renderEvaluationTui } from "./evaluation-render";

export interface StartEvaluationTuiOptions {
  runsRoot?: string;
  color?: boolean;
  xiaobaCommand?: string;
  xiaobaProjectRoot?: string;
  xiaobaRolesRoot?: string;
}

export async function startEvaluationTui(options: StartEvaluationTuiOptions = {}): Promise<void> {
  const runsRoot = path.resolve(options.runsRoot ?? "runs");
  let state = initialEvaluationTuiState(loadPreviousEvaluations(runsRoot));
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(renderEvaluationTui(state, { color: options.color ?? false, width: process.stdout.columns }));
    return;
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let active = true;
  let processing = false;

  const render = (): void => {
    process.stdout.write("\x1b[?25l\x1b[2J\x1b[H");
    process.stdout.write(renderEvaluationTui(state, {
      color: options.color ?? true,
      width: process.stdout.columns,
      height: process.stdout.rows,
    }));
  };

  return new Promise((resolve) => {
    const cleanup = (): void => {
      if (!active) return;
      active = false;
      process.stdin.off("keypress", onKeypress);
      process.stdout.off("resize", render);
      if (process.stdin.isRaw) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[?25h\x1b[0m\n");
      resolve();
    };

    const dispatch = async (action: EvaluationTuiAction): Promise<void> => {
      const before = state;
      const transition = reduceEvaluationTui(state, action);
      state = transition.state;
      if (before.screen === "previous" && state.screen === "result" && state.result) {
        state = { ...state, traceEvents: loadEvaluationTrace(state.result) };
      }
      render();
      await performEffect(transition.effect, runsRoot, options, (nextAction) => dispatch(nextAction), cleanup);
    };

    const onKeypress = (text: string, key: { name?: string; ctrl?: boolean }): void => {
      if (!active || processing) return;
      processing = true;
      void dispatch({ type: "key", name: key?.name, ctrl: key?.ctrl, text })
        .catch((error) => dispatch({ type: "error", message: errorMessage(error) }))
        .finally(() => { processing = false; });
    };

    process.stdin.on("keypress", onKeypress);
    process.stdout.on("resize", render);
    render();
  });
}

async function performEffect(
  effect: EvaluationTuiEffect,
  runsRoot: string,
  options: StartEvaluationTuiOptions,
  dispatch: (action: EvaluationTuiAction) => Promise<void>,
  cleanup: () => void
): Promise<void> {
  if (effect.type === "none") return;
  if (effect.type === "quit") {
    cleanup();
    return;
  }
  if (effect.type === "validate_candidate") {
    try {
      const name = effect.capability === "skill" ? loadSkillSelection(effect.value).name : validateRoleId(effect.value);
      await dispatch({ type: "candidate_valid", name });
    } catch (error) {
      await dispatch({ type: "error", message: errorMessage(error) });
    }
    return;
  }
  if (effect.type === "validate_case") {
    try {
      if (effect.runtime === "xiaoba") {
        const loaded = loadXiaoBaNativeCase(effect.path);
        await dispatch({ type: "case_valid", caseId: loaded.case_id });
      } else {
        const loaded = loadAgentE2ECase(effect.path);
        if (loaded.caseDefinition.target.adapter !== "openclaw") {
          throw new Error("OpenClaw evaluation requires case target.adapter=openclaw");
        }
        await dispatch({ type: "case_valid", caseId: loaded.caseDefinition.case_id });
      }
    } catch (error) {
      await dispatch({ type: "error", message: errorMessage(error) });
    }
    return;
  }
  try {
    const result = effect.runtime === "xiaoba"
      ? await runXiaoBaNativeEvaluation({
          request: effect.capability === "skill"
            ? createXiaoBaNativeSkillRequest({
                roleId: effect.baselineRole,
                skillPath: effect.candidateInput,
                casePaths: [effect.casePath],
                attemptsPerArm: effect.attempts,
                binaryPath: options.xiaobaCommand,
                projectRoot: options.xiaobaProjectRoot,
                rolesRoot: options.xiaobaRolesRoot,
              })
            : createXiaoBaNativeRoleRequest({
                baselineRoleId: effect.baselineRole,
                candidateRoleId: effect.candidateInput,
                casePaths: [effect.casePath],
                attemptsPerArm: effect.attempts,
                binaryPath: options.xiaobaCommand,
                projectRoot: options.xiaobaProjectRoot,
                rolesRoot: options.xiaobaRolesRoot,
              }),
          runs_root: runsRoot,
        })
      : await runSkillEvaluation({
          skillPath: effect.candidateInput,
          cases: [effect.casePath],
          attemptsPerArm: effect.attempts,
          runsRoot,
        });
    await dispatch({ type: "result", result, traceEvents: loadEvaluationTrace(result) });
  } catch (error) {
    await dispatch({ type: "error", message: errorMessage(error) });
  }
}

export function loadEvaluationTrace(result: AnyEvaluationResult): TraceViewEvent[] {
  if (result.schema === "barena.xiaoba_capability_evaluation_result.v1") {
    return loadXiaoBaEvaluationTrace(result.baseline.attempts, result.candidate.attempts);
  }
  const events: TraceViewEvent[] = [];
  for (const armResult of [result.baseline, result.candidate]) {
    const arm = armResult === result.baseline ? "baseline" as const : "candidate" as const;
    for (const run of armResult.run_refs) {
      for (const attempt of run.scorecard.attempts) {
        for (const event of readNdjson<BoundaryTraceEvent>(attempt.trace_ref)) {
          events.push({
            arm,
            case_id: run.case_id,
            attempt_id: attempt.attempt_id,
            timestamp: event.timestamp,
            kind: event.kind,
            message: event.message,
            observed_from: event.provenance.observed_from,
            component: event.provenance.component,
            recorded_by: "barena",
            layer: "boundary",
          });
        }
      }
    }
  }
  return events.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

export function loadPreviousEvaluations(runsRoot: string): PreviousEvaluation[] {
  if (!fs.existsSync(runsRoot)) return [];
  return fs.readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (entry.name.startsWith("skill-eval-") || entry.name.startsWith("xiaoba-")))
    .flatMap((entry): PreviousEvaluation[] => {
      for (const file of ["skill-evaluation.json", "capability-evaluation.json", "evaluation-result.json"]) {
        const resultRef = path.join(runsRoot, entry.name, file);
        if (!fs.existsSync(resultRef)) continue;
        try {
          const result = readJson<AnyEvaluationResult>(resultRef);
          if (["barena.skill_evaluation.v1", "barena.xiaoba_capability_evaluation_result.v1"].includes(result.schema)) {
            return [{ result, result_ref: resultRef }];
          }
        } catch {
          // A malformed historical result is ignored instead of breaking TUI startup.
        }
      }
      return [];
    })
    .sort((left, right) => right.result.created_at.localeCompare(left.result.created_at));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateRoleId(value: string): string {
  const roleId = value.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(roleId)) {
    throw new Error("XiaoBa Role ID must contain only letters, numbers, dot, underscore, or dash");
  }
  return roleId;
}

function loadXiaoBaEvaluationTrace(
  baseline: XiaoBaNativeAttemptResult[],
  candidate: XiaoBaNativeAttemptResult[]
): TraceViewEvent[] {
  const events: TraceViewEvent[] = [];
  for (const [arm, attempts] of [["baseline", baseline], ["candidate", candidate]] as const) {
    for (const attempt of attempts) {
      const boundaryRefs = acceptedEvidenceRefs(attempt, "boundary", [attempt.refs.boundary_trace]);
      for (const boundaryRef of boundaryRefs) {
        for (const boundary of parseJsonLines(boundaryRef)) {
          events.push(toTraceEvent(boundary, arm, attempt, "barena", "boundary", boundaryRef));
        }
      }
      for (const nativeRef of acceptedEvidenceRefs(attempt, "native", attempt.refs.native)) {
        for (const native of parseJsonLines(nativeRef)) {
          events.push(toTraceEvent(native, arm, attempt, "xiaoba", "native", nativeRef));
        }
      }
      for (const evaluatorRef of acceptedEvidenceRefs(attempt, "evaluator", attempt.refs.evaluator)) {
        for (const evaluator of parseJsonLines(evaluatorRef)) {
          events.push(toTraceEvent(evaluator, arm, attempt, "xiaoba", "evaluator", evaluatorRef));
        }
      }
    }
  }
  return events.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function acceptedEvidenceRefs(
  attempt: XiaoBaNativeAttemptResult,
  layer: "boundary" | "native" | "evaluator",
  fallback: string[]
): string[] {
  const accepted = attempt.evidence.filter((item) => item.layer === layer).map((item) => item.copied_ref);
  return accepted.length ? accepted : fallback;
}

function parseJsonLines(filePath: string): Record<string, unknown>[] {
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return [];
  const rows: Record<string, unknown>[] = [];
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rows.push(parsed as Record<string, unknown>);
    } catch {
      // stdout/stderr and other non-JSON debug files are not rendered as native trace events.
    }
  }
  return rows;
}

function toTraceEvent(
  row: Record<string, unknown>,
  arm: "baseline" | "candidate",
  attempt: XiaoBaNativeAttemptResult,
  recordedBy: "barena" | "xiaoba",
  layer: TraceViewEvent["layer"],
  sourceRef: string
): TraceViewEvent {
  const timestamp = stringField(row, ["timestamp", "created_at", "time"]) ?? "";
  const kind = stringField(row, ["kind", "type", "event"]) ?? "event";
  const message = stringField(row, ["message", "content", "detail", "text"]) ?? JSON.stringify(row);
  return {
    arm,
    case_id: attempt.case_id,
    attempt_id: String(attempt.attempt),
    timestamp,
    kind,
    message,
    observed_from: path.basename(sourceRef),
    component: recordedBy === "xiaoba" ? "xiaoba-cli" : "barena",
    recorded_by: recordedBy,
    layer,
  };
}

function stringField(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) if (typeof row[key] === "string") return row[key] as string;
  return undefined;
}
