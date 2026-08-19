import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { loadAgentE2ECase } from "../e2e/case-runner";
import { BoundaryTraceEvent } from "../e2e/types";
import { loadSkillSelection, runSkillEvaluation } from "../evaluation/run-skill-evaluation";
import { XiaoBaNativeAttemptResult } from "../evaluation/xiaoba-native-types";
import {
  createAdHocExploreScenario,
  runConnectedExploreScenario,
} from "../explore";
import {
  discoverLocalRuntimes,
  listXiaobaSkills,
  listXiaobaTargetProfiles,
  resolveCommandOnPath,
  resolveXiaobaInstallation,
  type LocalRuntimeDescriptor,
  type XiaobaRoleDescriptor,
  type XiaobaSkillDescriptor,
} from "../runtime-adapters";
import { listRunRecords } from "../runs/catalog";
import { resolveTrustedRunFile } from "../runs/path-safety";
import {
  isCompleteSkillEvaluationRun,
  isCompleteXiaoBaCapabilityRun,
} from "../runs/type-guards";
import { PortableTargetAdapter } from "../targets/portable-target-adapter";
import { XiaobaTargetAdapter } from "../targets/xiaoba-target-adapter";
import { readNdjson } from "../utils/fs";
import {
  AnyEvaluationResult,
  EvaluationTuiAction,
  EvaluationTuiEffect,
  EvaluationTuiHomeMode,
  EvaluationTuiInitialWorkflow,
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
  homeMode?: EvaluationTuiHomeMode;
  initialWorkflow?: EvaluationTuiInitialWorkflow;
  xiaobaCommand?: string;
  xiaobaProjectRoot?: string;
  xiaobaRolesRoot?: string;
  xiaobaSkillsRoot?: string;
  xiaobaEnvAllowlist?: string[];
  dshCommand?: string;
  dshProfile?: string;
  dshPatchPath?: string;
  dshPluginPath?: string;
  exploreModel?: string;
  initialExploreTask?: string;
  initialExploreMaxTurns?: number;
}

export async function startEvaluationTui(options: StartEvaluationTuiOptions = {}): Promise<void> {
  const runsRoot = path.resolve(options.runsRoot ?? "runs");
  const discovery = discoverTuiTargets(options);
  let state = initialEvaluationTuiState(loadPreviousEvaluations(runsRoot), {
    homeMode: options.homeMode,
    initialWorkflow: options.initialWorkflow,
    runtimes: discovery.runtimes,
    xiaobaRoles: discovery.roles,
    xiaobaSkills: discovery.skills,
    exploreModel: options.exploreModel,
    initialExploreTask: options.initialExploreTask,
    initialExploreMaxTurns: options.initialExploreMaxTurns,
  });
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(renderEvaluationTui(state, { color: options.color ?? false, width: process.stdout.columns }));
    return;
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let active = true;
  let activeExploreAbort: AbortController | undefined;
  let keyQueue: Promise<void> = Promise.resolve();

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
      activeExploreAbort?.abort("Barena TUI closed by user");
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
        state = {
          ...state,
          traceEvents: state.resultRoot ? loadEvaluationTrace(state.result, state.resultRoot) : [],
        };
      }
      render();
      const exploreAbort = transition.effect.type === "run_explore"
        ? new AbortController()
        : undefined;
      if (exploreAbort) activeExploreAbort = exploreAbort;
      try {
        await performEffect(
          transition.effect,
          runsRoot,
          options,
          (nextAction) => dispatch(nextAction),
          cleanup,
          exploreAbort?.signal
        );
      } finally {
        if (activeExploreAbort === exploreAbort) activeExploreAbort = undefined;
      }
    };

    const onKeypress = (text: string, key: { name?: string; ctrl?: boolean }): void => {
      if (!active || state.screen === "running") return;
      if (state.screen === "explore_running") {
        if (key.ctrl && key.name === "c") {
          activeExploreAbort?.abort("Explore cancelled by user");
          return;
        }
        if (key.name === "d") {
          void dispatch({ type: "key", name: key.name, text });
        }
        return;
      }
      keyQueue = keyQueue.then(async () => {
        if (!active) return;
        try {
          await dispatch({ type: "key", name: key?.name, ctrl: key?.ctrl, text });
        } catch (error) {
          await dispatch({ type: "error", message: errorMessage(error) });
        }
      });
      void keyQueue;
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
  cleanup: () => void,
  signal?: AbortSignal
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
      await dispatch({ type: "error", message: errorMessage(error), returnScreen: "candidate" });
    }
    return;
  }
  if (effect.type === "validate_case") {
    try {
      if (effect.runtime === "xiaoba") {
        const loaded = loadAgentE2ECase(effect.path);
        if (loaded.caseDefinition.target.adapter !== "xiaoba" || loaded.caseDefinition.target.runtime !== "xiaobaos") {
          throw new Error("XiaobaOS evaluation requires case target.adapter=xiaoba and target.runtime=xiaobaos");
        }
        await dispatch({ type: "case_valid", caseId: loaded.caseDefinition.case_id, targetRuntime: "xiaobaos" });
      } else {
        const loaded = loadAgentE2ECase(effect.path);
        if (effect.runtime === "openclaw" && loaded.caseDefinition.target.adapter !== "openclaw") {
          throw new Error("OpenClaw evaluation requires case target.adapter=openclaw");
        }
        if (effect.runtime === "portable" && loaded.caseDefinition.target.adapter !== "portable") {
          throw new Error("Hermes/custom evaluation requires case target.adapter=portable");
        }
        await dispatch({
          type: "case_valid",
          caseId: loaded.caseDefinition.case_id,
          targetRuntime: loaded.caseDefinition.target.runtime,
        });
      }
    } catch (error) {
      await dispatch({ type: "error", message: errorMessage(error), returnScreen: "case" });
    }
    return;
  }
  if (effect.type === "run_explore") {
    try {
      const result = await runConnectedExploreScenario(
        createAdHocExploreScenario({
          runtime: effect.runtime,
          role: effect.role,
          skill: effect.skill,
          task: effect.task,
          max_turns: effect.maxTurns,
          timeout_ms: effect.timeoutMs,
          model: effect.model,
          env_allowlist: options.xiaobaEnvAllowlist,
        }),
        {
          runs_root: runsRoot,
          signal,
          on_progress: async (event) => {
            await dispatch({ type: "explore_progress", event });
          },
          xiaoba: {
            command: options.xiaobaCommand,
            project_root: options.xiaobaProjectRoot,
            roles_root: options.xiaobaRolesRoot,
            skills_root: options.xiaobaSkillsRoot,
            env_allowlist: options.xiaobaEnvAllowlist,
          },
          ...(effect.runtime === "dsh" && {
            dsh: {
              command: options.dshCommand,
              profile: options.dshProfile,
              patch_path: options.dshPatchPath,
              plugin_path: options.dshPluginPath,
              env_allowlist: options.xiaobaEnvAllowlist,
            },
          }),
        }
      );
      await dispatch({ type: "explore_result", result });
    } catch (error) {
      await dispatch({
        type: "error",
        message: errorMessage(error),
        returnScreen: "explore_review",
      });
    }
    return;
  }
  try {
    const result = effect.runtime === "xiaoba"
      ? effect.capability === "role"
        ? (() => { throw new Error("Role A/B is held during migration to Barena-owned ordinary target execution; XiaobaOS Arena fallback is disabled"); })()
        : await runSkillEvaluation({
            skillPath: effect.candidateInput,
            cases: [effect.casePath],
            attemptsPerArm: effect.attempts,
            runsRoot,
            targetId: "xiaobaos",
            targetAdapter: new XiaobaTargetAdapter({
              command: options.xiaobaCommand,
              projectRoot: options.xiaobaProjectRoot,
              rolesRoot: options.xiaobaRolesRoot,
            }),
          })
      : effect.runtime === "openclaw"
        ? await runSkillEvaluation({
            skillPath: effect.candidateInput,
            cases: [effect.casePath],
            attemptsPerArm: effect.attempts,
            runsRoot,
          })
        : await runPortableSkillEvaluation(effect, runsRoot);
    const resultRoot = evaluationRoot(result);
    await dispatch({
      type: "result",
      result,
      resultRoot,
      traceEvents: resultRoot ? loadEvaluationTrace(result, resultRoot) : [],
    });
  } catch (error) {
    await dispatch({ type: "error", message: errorMessage(error), returnScreen: "review" });
  }
}

export function discoverTuiTargets(options: StartEvaluationTuiOptions): {
  runtimes: LocalRuntimeDescriptor[];
  roles: XiaobaRoleDescriptor[];
  skills: XiaobaSkillDescriptor[];
} {
  let runtimes = discoverLocalRuntimes();
  const installation = resolveXiaobaInstallation({
    command: options.xiaobaCommand,
    project_root: options.xiaobaProjectRoot,
    roles_root: options.xiaobaRolesRoot,
    skills_root: options.xiaobaSkillsRoot,
  });
  if (installation.command_path) {
    runtimes = runtimes.map((runtime) =>
      runtime.id === "xiaobaos"
        ? {
            ...runtime,
            installed: true,
            command_path: installation.command_path,
            detail: "installed; Explore adapter available",
          }
        : runtime
    );
  }
  const dshCommandPath = resolveTuiCommand(options.dshCommand);
  if (dshCommandPath) {
    runtimes = runtimes.map((runtime) =>
      runtime.id === "dsh"
        ? {
            ...runtime,
            installed: true,
            command_path: dshCommandPath,
            detail: "installed; Explore adapter available",
          }
        : runtime
    );
  }
  const roles = installation.roles_root
    ? listXiaobaTargetProfiles(installation.roles_root)
    : [];
  const skills = listXiaobaSkills(installation.skills_root, roles);
  return {
    runtimes: runtimes.filter((runtime) => runtime.installed),
    roles,
    skills,
  };
}

function resolveTuiCommand(command: string | undefined): string | undefined {
  const requested = command?.trim();
  if (!requested) return undefined;
  const candidate = requested.includes(path.sep)
    ? path.resolve(requested)
    : resolveCommandOnPath(requested);
  if (!candidate) return undefined;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

async function runPortableSkillEvaluation(
  effect: Extract<EvaluationTuiEffect, { type: "run" }>,
  runsRoot: string
): Promise<AnyEvaluationResult> {
  if (!effect.portableRuntime) throw new Error("Portable case is missing target.runtime");
  if (!effect.targetCommand) throw new Error("Portable target driver command is required");
  return runSkillEvaluation({
    skillPath: effect.candidateInput,
    cases: [effect.casePath],
    attemptsPerArm: effect.attempts,
    runsRoot,
    targetId: effect.portableRuntime,
    targetAdapter: new PortableTargetAdapter({
      command: effect.targetCommand,
      runtime: effect.portableRuntime,
    }),
  });
}

export function loadEvaluationTrace(result: AnyEvaluationResult, runRoot: string): TraceViewEvent[] {
  if (result.schema === "barena.xiaoba_capability_evaluation_result.v1") {
    return loadXiaoBaEvaluationTrace(result.baseline.attempts, result.candidate.attempts, runRoot);
  }
  const events: TraceViewEvent[] = [];
  for (const armResult of [result.baseline, result.candidate]) {
    const arm = armResult === result.baseline ? "baseline" as const : "candidate" as const;
    for (const run of armResult.run_refs) {
      for (const attempt of run.scorecard.attempts) {
        const traceRef = trustedFile(runRoot, attempt.trace_ref);
        if (!traceRef) continue;
        for (const event of readNdjson<BoundaryTraceEvent>(traceRef)) {
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
  return listRunRecords(runsRoot)
    .filter((run) => run.kind === "skill_evaluation" || run.kind === "xiaoba_capability")
    .flatMap((run): PreviousEvaluation[] => {
      if (isCompleteSkillEvaluationRun(run.result) || isCompleteXiaoBaCapabilityRun(run.result)) {
        return [{ result: run.result, result_ref: run.result_ref, run_root: run.run_root }];
      }
      return [];
    })
    .sort((left, right) => right.result.created_at.localeCompare(left.result.created_at));
}

function evaluationRoot(result: AnyEvaluationResult): string | undefined {
  if (typeof result.request_ref !== "string" || !result.request_ref) return undefined;
  const root = path.dirname(path.resolve(result.request_ref));
  return fs.existsSync(root) && fs.statSync(root).isDirectory() ? root : undefined;
}

function trustedFile(runRoot: string, ref: string): string | undefined {
  try {
    return resolveTrustedRunFile(runRoot, ref);
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateRoleId(value: string): string {
  const roleId = value.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(roleId)) {
    throw new Error("XiaobaOS Role ID must contain only letters, numbers, dot, underscore, or dash");
  }
  return roleId;
}

function loadXiaoBaEvaluationTrace(
  baseline: XiaoBaNativeAttemptResult[],
  candidate: XiaoBaNativeAttemptResult[],
  runRoot: string
): TraceViewEvent[] {
  const events: TraceViewEvent[] = [];
  for (const [arm, attempts] of [["baseline", baseline], ["candidate", candidate]] as const) {
    for (const attempt of attempts) {
      const boundaryRefs = acceptedEvidenceRefs(attempt, "boundary", [attempt.refs.boundary_trace]);
      for (const boundaryRef of boundaryRefs) {
        for (const boundary of parseJsonLines(boundaryRef, runRoot)) {
          events.push(toTraceEvent(boundary, arm, attempt, "barena", "boundary", boundaryRef));
        }
      }
      for (const nativeRef of acceptedEvidenceRefs(attempt, "native", attempt.refs.native)) {
        for (const native of parseJsonLines(nativeRef, runRoot)) {
          events.push(toTraceEvent(native, arm, attempt, "xiaoba", "native", nativeRef));
        }
      }
      for (const evaluatorRef of acceptedEvidenceRefs(attempt, "evaluator", attempt.refs.evaluator)) {
        for (const evaluator of parseJsonLines(evaluatorRef, runRoot)) {
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

function parseJsonLines(filePath: string, runRoot: string): Record<string, unknown>[] {
  const trustedRef = trustedFile(runRoot, filePath);
  if (!trustedRef) return [];
  const rows: Record<string, unknown>[] = [];
  for (const line of fs.readFileSync(trustedRef, "utf8").split(/\r?\n/).filter(Boolean)) {
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
