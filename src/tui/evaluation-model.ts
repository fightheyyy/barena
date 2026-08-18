import { SkillEvaluationResultV1 } from "../evaluation/types";
import { XiaoBaCapabilityEvaluationResultV1 } from "../evaluation/xiaoba-native-types";
import type {
  ExploreProgressEvent,
  ExploreResultV1,
} from "../explore/types";
import type {
  LocalRuntimeDescriptor,
  XiaobaRoleDescriptor,
  XiaobaSkillDescriptor,
} from "../runtime-adapters";

export type EvaluationRuntime = "xiaoba" | "openclaw" | "portable";
export type EvaluationCapability = "skill" | "role";
export type AnyEvaluationResult = SkillEvaluationResultV1 | XiaoBaCapabilityEvaluationResultV1;
export type EvaluationTuiHomeMode = "product" | "skill";
export type EvaluationTuiInitialWorkflow = "home" | "explore";

export type EvaluationTuiScreen =
  | "home"
  | "skill_home"
  | "explore_runtime"
  | "explore_role"
  | "explore_task"
  | "explore_skill"
  | "explore_review"
  | "explore_confirm"
  | "explore_running"
  | "explore_result"
  | "explore_cases"
  | "explore_transcript"
  | "dag"
  | "baseline_role"
  | "candidate"
  | "target"
  | "target_command"
  | "case"
  | "review"
  | "confirm"
  | "running"
  | "result"
  | "trace"
  | "previous"
  | "prerequisites"
  | "error";

export interface TraceViewEvent {
  arm: "baseline" | "candidate";
  case_id: string;
  attempt_id: string;
  timestamp: string;
  kind: string;
  message: string;
  observed_from: string;
  component: string;
  recorded_by: "barena" | "xiaoba";
  layer: "boundary" | "native" | "evaluator" | "verifier" | "debug";
}

export interface PreviousEvaluation {
  result: AnyEvaluationResult;
  result_ref: string;
  run_root?: string;
}

export interface EvaluationTuiState {
  screen: EvaluationTuiScreen;
  homeMode: EvaluationTuiHomeMode;
  selected: number;
  runtimes: LocalRuntimeDescriptor[];
  xiaobaRoles: XiaobaRoleDescriptor[];
  xiaobaSkills: XiaobaSkillDescriptor[];
  intentInput: string;
  exploreRuntime?: LocalRuntimeDescriptor;
  exploreRole?: XiaobaRoleDescriptor;
  exploreSkill?: XiaobaSkillDescriptor;
  exploreSkillInput: string;
  exploreRoleInput: string;
  exploreRoleCandidateIds: string[];
  exploreTask: string;
  exploreMaxTurns: number;
  exploreTimeoutMs: number;
  exploreConfirmInput: string;
  exploreDetails: boolean;
  exploreTranscriptOffset: number;
  exploreModel?: string;
  exploreResult?: ExploreResultV1;
  exploreProgress: ExploreProgressEvent[];
  runtime: EvaluationRuntime;
  capability: EvaluationCapability;
  baselineRole: string;
  candidateInput: string;
  candidateName?: string;
  targetCommand: string;
  portableRuntime?: string;
  casePath: string;
  caseId?: string;
  attempts: number;
  result?: AnyEvaluationResult;
  resultRoot?: string;
  traceEvents: TraceViewEvent[];
  traceOffset: number;
  previous: PreviousEvaluation[];
  error?: string;
  errorReturnScreen?: EvaluationTuiScreen;
}

export type EvaluationTuiEffect =
  | { type: "none" }
  | { type: "quit" }
  | {
      type: "run_explore";
      runtime: "xiaobaos";
      role: string;
      skill?: string;
      task: string;
      maxTurns: number;
      timeoutMs: number;
      model?: string;
    }
  | { type: "validate_candidate"; runtime: EvaluationRuntime; capability: EvaluationCapability; value: string }
  | { type: "validate_case"; runtime: EvaluationRuntime; path: string }
  | {
      type: "run";
      runtime: EvaluationRuntime;
      capability: EvaluationCapability;
      baselineRole: string;
      candidateInput: string;
      targetCommand: string;
      portableRuntime?: string;
      casePath: string;
      attempts: number;
    };

export interface EvaluationTuiTransition {
  state: EvaluationTuiState;
  effect: EvaluationTuiEffect;
}

export type EvaluationTuiAction =
  | { type: "key"; name?: string; text?: string; ctrl?: boolean }
  | { type: "explore_progress"; event: ExploreProgressEvent }
  | { type: "explore_result"; result: ExploreResultV1 }
  | { type: "candidate_valid"; name: string }
  | { type: "case_valid"; caseId: string; targetRuntime?: string }
  | { type: "result"; result: AnyEvaluationResult; resultRoot?: string; traceEvents: TraceViewEvent[] }
  | { type: "error"; message: string; returnScreen?: EvaluationTuiScreen };

const HOME_ITEMS = 8;
export const AUTO_EXPLORE_MAX_TURNS = 6;

export function initialEvaluationTuiState(
  previous: PreviousEvaluation[] = [],
  options: {
    homeMode?: EvaluationTuiHomeMode;
    initialWorkflow?: EvaluationTuiInitialWorkflow;
    runtimes?: LocalRuntimeDescriptor[];
    xiaobaRoles?: XiaobaRoleDescriptor[];
    xiaobaSkills?: XiaobaSkillDescriptor[];
    exploreModel?: string;
    initialExploreTask?: string;
    initialExploreMaxTurns?: number;
  } = {}
): EvaluationTuiState {
  const homeMode = options.homeMode ?? "skill";
  const initialExplore = resolveAutomaticExploreTarget(
    options.runtimes ?? [],
    options.xiaobaRoles ?? []
  );
  const initialTask = options.initialExploreTask?.trim() ?? "";
  const initialScreen: EvaluationTuiScreen =
    homeMode === "product" && options.initialWorkflow === "explore"
      ? initialExplore.role
        ? initialTask
          ? "explore_review"
          : "explore_task"
        : initialExplore.runtime
          ? "explore_role"
          : "explore_runtime"
      : "home";
  return {
    screen: initialScreen,
    homeMode,
    selected: initialScreen === "explore_runtime"
      ? Math.max(0, initialExplore.runtimeIndex)
      : 0,
    runtimes: options.runtimes ?? [],
    xiaobaRoles: options.xiaobaRoles ?? [],
    xiaobaSkills: options.xiaobaSkills ?? [],
    intentInput: "",
    exploreSkillInput: "",
    exploreRoleInput: "",
    exploreRoleCandidateIds: [],
    exploreTask: initialTask,
    exploreMaxTurns: Math.max(
      1,
      Math.floor(options.initialExploreMaxTurns ?? AUTO_EXPLORE_MAX_TURNS)
    ),
    exploreTimeoutMs: 180_000,
    exploreConfirmInput: "",
    exploreDetails: false,
    exploreTranscriptOffset: 0,
    exploreProgress: [],
    ...(initialExplore.runtime && { exploreRuntime: initialExplore.runtime }),
    ...(initialExplore.role && { exploreRole: initialExplore.role }),
    ...(options.exploreModel && { exploreModel: options.exploreModel }),
    runtime: "xiaoba",
    capability: "skill",
    baselineRole: "",
    candidateInput: "",
    targetCommand: "",
    casePath: "",
    attempts: 2,
    traceEvents: [],
    traceOffset: 0,
    previous,
  };
}

export function reduceEvaluationTui(
  state: EvaluationTuiState,
  action: EvaluationTuiAction
): EvaluationTuiTransition {
  if (action.type === "explore_progress") {
    return next({
      ...state,
      exploreProgress: [...state.exploreProgress, action.event].slice(-80),
    });
  }
  if (action.type === "explore_result") {
    return next({
      ...state,
      screen: "explore_result",
      exploreResult: action.result,
      selected: 0,
    });
  }
  if (action.type === "candidate_valid") {
    const nextScreen: EvaluationTuiScreen = state.runtime === "xiaoba"
      ? "case"
      : state.runtime === "openclaw"
        ? "target"
        : "target_command";
    return next({ ...state, screen: nextScreen, candidateName: action.name, selected: 0 });
  }
  if (action.type === "case_valid") {
    return next({
      ...state,
      screen: "review",
      caseId: action.caseId,
      portableRuntime: action.targetRuntime ?? state.portableRuntime,
      selected: 0,
    });
  }
  if (action.type === "result") {
    return next({ ...state, screen: "result", result: action.result, resultRoot: action.resultRoot, traceEvents: action.traceEvents, traceOffset: 0 });
  }
  if (action.type === "error") {
    const returnScreen = action.returnScreen ?? (state.screen === "running" ? "review" : state.screen);
    return next({ ...state, screen: "error", error: action.message, errorReturnScreen: returnScreen });
  }

  const key = action.name;
  if (action.ctrl && key === "c") return effect(state, { type: "quit" });
  if (
    key === "q" &&
    !(state.screen === "home" && state.homeMode === "product") &&
    ![
      "explore_task",
      "explore_review",
      "baseline_role",
      "candidate",
      "target_command",
      "case",
    ].includes(state.screen)
  ) {
    return effect(state, { type: "quit" });
  }

  if (state.screen === "home") {
    if (state.homeMode === "product") {
      if (key === "q") return effect(state, { type: "quit" });
      if (key === "d") {
        return next({ ...state, screen: "dag", selected: 0 });
      }
      if (key === "p") {
        return next({ ...state, screen: "previous", selected: 0 });
      }
      if (key === "?" || action.text === "?") {
        return next({ ...state, screen: "prerequisites", selected: 0 });
      }
      if (key === "up" || key === "k") {
        return next({ ...state, selected: wrap(state.selected - 1, 3) });
      }
      if (key === "down" || key === "j") {
        return next({ ...state, selected: wrap(state.selected + 1, 3) });
      }
      if (key && /^[1-3]$/.test(key)) {
        return activateProductHomeItem(state, Number(key) - 1);
      }
      if (key === "return") {
        return activateProductHomeItem(state, state.selected);
      }
      return next(state);
    }
    if (key === "up" || key === "k") return next({ ...state, selected: wrap(state.selected - 1, HOME_ITEMS) });
    if (key === "down" || key === "j") return next({ ...state, selected: wrap(state.selected + 1, HOME_ITEMS) });
    if (key && /^[1-8]$/.test(key)) return activateSkillHomeItem(state, Number(key) - 1);
    if (key === "return") return activateSkillHomeItem(state, state.selected);
    return next(state);
  }

  if (state.screen === "skill_home") {
    if (key === "escape" || key === "b") {
      return next({ ...state, screen: "home", selected: 3 });
    }
    if (key === "up" || key === "k") {
      return next({ ...state, selected: wrap(state.selected - 1, HOME_ITEMS) });
    }
    if (key === "down" || key === "j") {
      return next({ ...state, selected: wrap(state.selected + 1, HOME_ITEMS) });
    }
    if (key && /^[1-8]$/.test(key)) {
      return activateSkillHomeItem(state, Number(key) - 1);
    }
    if (key === "return") return activateSkillHomeItem(state, state.selected);
    return next(state);
  }

  if (state.screen === "explore_runtime") {
    if (key === "escape" || key === "b") {
      return state.homeMode === "product"
        ? next({ ...state, screen: "home", selected: 0 })
        : effect(state, { type: "quit" });
    }
    const count = Math.max(1, state.runtimes.length);
    if (key === "up" || key === "k") {
      return next({ ...state, selected: wrap(state.selected - 1, count) });
    }
    if (key === "down" || key === "j") {
      return next({ ...state, selected: wrap(state.selected + 1, count) });
    }
    if (key === "return") {
      const runtime = state.runtimes[state.selected];
      if (!runtime) {
        return next({
          ...state,
          screen: "error",
          error: "No supported Agent Runtime CLI was found on PATH.",
          errorReturnScreen: "explore_runtime",
        });
      }
      if (runtime.explore_support !== "ready") {
        return next({
          ...state,
          screen: "error",
          error: `${runtime.display_name} is installed, but its Explore adapter is not implemented yet.`,
          errorReturnScreen: "explore_runtime",
        });
      }
      if (runtime.id !== "xiaobaos") {
        return next({
          ...state,
          screen: "error",
          error: `Explore adapter is not available for ${runtime.display_name}.`,
          errorReturnScreen: "explore_runtime",
        });
      }
      if (!state.xiaobaRoles.length) {
        return next({
          ...state,
          screen: "error",
          error: "XiaoBaOS is installed, but no selectable target Roles were found.",
          errorReturnScreen: "explore_runtime",
        });
      }
      return next({
        ...state,
        screen: "explore_role",
        exploreRuntime: runtime,
        exploreRole: undefined,
        exploreSkill: undefined,
        exploreSkillInput: "",
        exploreTask: "",
        selected: 0,
      });
    }
    return next(state);
  }

  if (state.screen === "explore_role") {
    if (key === "escape" || key === "b") {
      return next({ ...state, screen: "explore_runtime", selected: 0 });
    }
    const count = Math.max(1, state.xiaobaRoles.length);
    if (key === "up" || key === "k") {
      return next({ ...state, selected: wrap(state.selected - 1, count) });
    }
    if (key === "down" || key === "j") {
      return next({ ...state, selected: wrap(state.selected + 1, count) });
    }
    if (key === "return" && state.xiaobaRoles[state.selected]) {
      return next({
        ...state,
        screen: "explore_task",
        exploreRole: state.xiaobaRoles[state.selected],
        exploreSkill: undefined,
        exploreSkillInput: "",
        exploreTask: "",
        exploreRoleInput: "",
        exploreRoleCandidateIds: [],
        exploreConfirmInput: "",
        selected: 0,
      });
    }
    return next(state);
  }

  if (state.screen === "explore_task") {
    if (key === "escape") {
      return state.homeMode === "product"
        ? next({ ...state, screen: "home", selected: 0 })
        : next({ ...state, screen: "explore_role", selected: 0 });
    }
    if (action.ctrl && key === "u") return next({ ...state, exploreTask: "" });
    if (key === "backspace") {
      return next({ ...state, exploreTask: state.exploreTask.slice(0, -1) });
    }
    if (key === "return" && state.exploreTask.trim()) {
      return resolveExploreComposer(state);
    }
    return next({
      ...state,
      exploreTask: appendText(state.exploreTask, action.text),
    });
  }

  if (state.screen === "explore_skill") {
    if (key === "escape" || key === "b") {
      return next({
        ...state,
        screen: "explore_task",
        exploreSkillInput: "",
        selected: 0,
      });
    }
    const skills = visibleExploreSkills(state);
    if (action.ctrl && key === "u") {
      return next({ ...state, exploreSkillInput: "", selected: 0 });
    }
    if (key === "backspace") {
      return next({
        ...state,
        exploreSkillInput: state.exploreSkillInput.slice(0, -1),
        selected: 0,
      });
    }
    if (key === "up" || key === "k") {
      return next({
        ...state,
        selected: wrap(state.selected - 1, Math.max(1, skills.length)),
      });
    }
    if (key === "down" || key === "j") {
      return next({
        ...state,
        selected: wrap(state.selected + 1, Math.max(1, skills.length)),
      });
    }
    if (key === "return" && skills[state.selected]) {
      return next({
        ...state,
        screen: "explore_task",
        exploreSkill: skills[state.selected],
        exploreSkillInput: "",
        selected: 0,
      });
    }
    return next({
      ...state,
      exploreSkillInput: appendText(state.exploreSkillInput, action.text),
      selected: action.text ? 0 : state.selected,
    });
  }

  if (state.screen === "explore_review") {
    if (key === "escape" || key === "e") {
      return next({
        ...state,
        screen: "explore_task",
        exploreConfirmInput: "",
      });
    }
    if (key === "return") {
      return beginExploreRun(state);
    }
    return next(state);
  }

  if (state.screen === "explore_confirm") {
    if (key === "escape" || key === "n") {
      return next({ ...state, screen: "explore_review" });
    }
    if (
      key === "y" &&
      state.exploreRuntime?.id === "xiaobaos" &&
      state.exploreRole &&
      state.exploreTask
    ) {
      return beginExploreRun(state);
    }
    return next(state);
  }

  if (state.screen === "explore_running") {
    if (key === "d") {
      return next({ ...state, exploreDetails: !state.exploreDetails });
    }
    return next(state);
  }

  if (state.screen === "explore_result") {
    if (key === "c" && state.exploreResult?.replay_case_candidates.length) {
      return next({ ...state, screen: "explore_cases", selected: 0 });
    }
    if (key === "v" && state.exploreResult?.transcript.length) {
      return next({
        ...state,
        screen: "explore_transcript",
        exploreTranscriptOffset: 0,
      });
    }
    if (key === "e") {
      return next({
        ...state,
        screen: "explore_task",
        exploreConfirmInput: "",
      });
    }
    if (key === "h" || key === "escape") {
      return state.homeMode === "product"
        ? next({ ...state, screen: "home", selected: 0 })
        : next({ ...state, screen: "explore_runtime", selected: 0 });
    }
    return next(state);
  }

  if (state.screen === "explore_cases") {
    if (key === "escape" || key === "b") {
      return next({ ...state, screen: "explore_result" });
    }
    const length = state.exploreResult?.replay_case_candidates.length ?? 0;
    if (key === "down" || key === "j") {
      return next({
        ...state,
        selected: Math.min(Math.max(0, length - 1), state.selected + 1),
      });
    }
    if (key === "up" || key === "k") {
      return next({ ...state, selected: Math.max(0, state.selected - 1) });
    }
    return next(state);
  }

  if (state.screen === "explore_transcript") {
    if (key === "escape" || key === "b") {
      return next({ ...state, screen: "explore_result" });
    }
    const length = state.exploreResult?.transcript.length ?? 0;
    if (key === "down" || key === "j") {
      return next({
        ...state,
        exploreTranscriptOffset: Math.min(
          Math.max(0, length - 1),
          state.exploreTranscriptOffset + 1
        ),
      });
    }
    if (key === "up" || key === "k") {
      return next({
        ...state,
        exploreTranscriptOffset: Math.max(
          0,
          state.exploreTranscriptOffset - 1
        ),
      });
    }
    return next(state);
  }

  if (state.screen === "baseline_role") {
    if (key === "escape") return next({ ...state, screen: "home", selected: 0 });
    if (action.ctrl && key === "u") return next({ ...state, baselineRole: "" });
    if (key === "backspace") return next({ ...state, baselineRole: state.baselineRole.slice(0, -1) });
    if (key === "return" && state.baselineRole.trim()) return next({ ...state, screen: "candidate" });
    return next({ ...state, baselineRole: appendText(state.baselineRole, action.text) });
  }

  if (state.screen === "candidate") {
    if (key === "escape") {
      return next({ ...state, screen: state.runtime === "xiaoba" ? "baseline_role" : "home" });
    }
    if (action.ctrl && key === "u") return next({ ...state, candidateInput: "" });
    if (key === "backspace") return next({ ...state, candidateInput: state.candidateInput.slice(0, -1) });
    if (key === "return" && state.candidateInput.trim()) {
      return effect(state, {
        type: "validate_candidate",
        runtime: state.runtime,
        capability: state.capability,
        value: normalizeInput(state.candidateInput),
      });
    }
    return next({ ...state, candidateInput: appendText(state.candidateInput, action.text) });
  }

  if (state.screen === "target") {
    if (key === "escape") return next({ ...state, screen: "candidate" });
    if (key === "return") return next({ ...state, screen: "case", selected: 0 });
    return next(state);
  }

  if (state.screen === "target_command") {
    if (key === "escape") return next({ ...state, screen: "candidate" });
    if (action.ctrl && key === "u") return next({ ...state, targetCommand: "" });
    if (key === "backspace") return next({ ...state, targetCommand: state.targetCommand.slice(0, -1) });
    if (key === "return" && state.targetCommand.trim()) return next({
      ...state,
      targetCommand: normalizeInput(state.targetCommand),
      screen: "case",
      selected: 0,
    });
    return next({ ...state, targetCommand: appendText(state.targetCommand, action.text) });
  }

  if (state.screen === "case") {
    if (key === "escape") {
      const screen: EvaluationTuiScreen = state.runtime === "xiaoba"
        ? "candidate"
        : state.runtime === "openclaw"
          ? "target"
          : "target_command";
      return next({ ...state, screen });
    }
    if (action.ctrl && key === "u") return next({ ...state, casePath: "" });
    if (key === "backspace") return next({ ...state, casePath: state.casePath.slice(0, -1) });
    if (key === "return" && state.casePath.trim()) {
      return effect(state, { type: "validate_case", runtime: state.runtime, path: normalizeInput(state.casePath) });
    }
    return next({ ...state, casePath: appendText(state.casePath, action.text) });
  }

  if (state.screen === "review") {
    if (key === "escape") return next({ ...state, screen: "case" });
    if (key === "left" || key === "down" || key === "j") {
      return next({ ...state, attempts: Math.max(1, state.attempts - 1) });
    }
    if (key === "right" || key === "up" || key === "k") {
      return next({ ...state, attempts: Math.min(11, state.attempts + 1) });
    }
    if (key === "-" || key === "subtract") return next({ ...state, attempts: Math.max(1, state.attempts - 1) });
    if (key === "+" || key === "add" || key === "=") return next({ ...state, attempts: Math.min(11, state.attempts + 1) });
    if (key === "return") {
      return next({ ...state, screen: "confirm" });
    }
    return next(state);
  }

  if (state.screen === "confirm") {
    if (key === "escape" || key === "n") return next({ ...state, screen: "review" });
    if (key === "y") {
      return effect(
        { ...state, screen: "running" },
        {
          type: "run",
          runtime: state.runtime,
          capability: state.capability,
          baselineRole: state.baselineRole,
          candidateInput: normalizeInput(state.candidateInput),
          targetCommand: normalizeInput(state.targetCommand),
          portableRuntime: state.portableRuntime,
          casePath: normalizeInput(state.casePath),
          attempts: state.attempts,
        }
      );
    }
    return next(state);
  }

  if (state.screen === "result") {
    if (key === "t" || key === "return") return next({ ...state, screen: "trace", traceOffset: 0 });
    if (key === "e" && state.candidateInput && state.casePath) return next({ ...state, screen: "review" });
    if (key === "h" || key === "escape") return next({ ...state, screen: "home", selected: 0 });
    return next(state);
  }

  if (state.screen === "trace") {
    if (key === "escape" || key === "b") return next({ ...state, screen: "result" });
    if (key === "down" || key === "j") {
      return next({ ...state, traceOffset: Math.min(Math.max(0, state.traceEvents.length - 1), state.traceOffset + 1) });
    }
    if (key === "up" || key === "k") return next({ ...state, traceOffset: Math.max(0, state.traceOffset - 1) });
    return next(state);
  }

  if (state.screen === "dag") {
    if (key === "escape" || key === "b" || key === "return") {
      return next({
        ...state,
        screen: "home",
        selected: state.homeMode === "product" ? 0 : 4,
      });
    }
    return next(state);
  }

  if (state.screen === "previous") {
    if (key === "escape" || key === "b") {
      return next({
        ...state,
        screen: "home",
        selected: state.homeMode === "product" ? 0 : 5,
      });
    }
    if (key === "down" || key === "j") return next({ ...state, selected: wrap(state.selected + 1, Math.max(1, state.previous.length)) });
    if (key === "up" || key === "k") return next({ ...state, selected: wrap(state.selected - 1, Math.max(1, state.previous.length)) });
    if (key === "return" && state.previous[state.selected]) {
      const previous = state.previous[state.selected];
      return next({ ...state, screen: "result", result: previous.result, resultRoot: previous.run_root, traceEvents: [], traceOffset: 0 });
    }
    return next(state);
  }

  if (state.screen === "prerequisites") {
    if (key === "escape" || key === "b" || key === "return") {
      return next({
        ...state,
        screen: "home",
        selected: state.homeMode === "product" ? 0 : 6,
      });
    }
  }
  if (state.screen === "error") {
    if (key === "h") return next({ ...state, screen: "home", selected: 0, error: undefined, errorReturnScreen: undefined });
    if (key === "escape" || key === "b" || key === "return" || key === "r") {
      return next({
        ...state,
        screen: state.errorReturnScreen && state.errorReturnScreen !== "error" ? state.errorReturnScreen : "home",
        error: undefined,
        errorReturnScreen: undefined,
      });
    }
  }
  return next(state);
}

function resolveExploreComposer(
  state: EvaluationTuiState
): EvaluationTuiTransition {
  const input = normalizeInput(state.exploreTask);
  const agentCommand = input.match(
    /^\/agent(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i
  );
  if (agentCommand) {
    const requested = agentCommand[1]?.trim();
    const objective = agentCommand[2]?.trim() ?? "";
    if (!requested) {
      return next({
        ...state,
        screen: "error",
        error: "Use /agent <role-id>, for example /agent engineer-cat.",
        errorReturnScreen: "explore_task",
      });
    }
    const role = resolveExploreRole(requested, state.xiaobaRoles);
    if (!role) {
      return next({
        ...state,
        screen: "error",
        error: `Agent profile ${requested} was not found.`,
        errorReturnScreen: "explore_task",
      });
    }
    return next({
      ...state,
      screen: objective ? "explore_review" : "explore_task",
      exploreRole: role,
      exploreSkill: undefined,
      exploreSkillInput: "",
      exploreTask: objective,
      selected: 0,
    });
  }
  const command = input.match(
    /^\/skill(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i
  );
  if (!command) {
    return next({
      ...state,
      screen: "explore_review",
      exploreTask: input,
      exploreMaxTurns: AUTO_EXPLORE_MAX_TURNS,
      exploreConfirmInput: "",
      exploreResult: undefined,
      exploreProgress: [],
      exploreDetails: false,
    });
  }

  const requested = command[1]?.trim();
  const objective = command[2]?.trim() ?? "";
  if (!requested) {
    return next({
      ...state,
      screen: "explore_skill",
      exploreTask: objective,
      exploreSkillInput: "",
      selected: 0,
    });
  }
  if (["clear", "none", "off"].includes(requested.toLowerCase())) {
    return next({
      ...state,
      screen: objective ? "explore_review" : "explore_task",
      exploreSkill: undefined,
      exploreSkillInput: "",
      exploreTask: objective,
      selected: 0,
    });
  }
  const skill = resolveExploreSkill(requested, availableExploreSkills(state));
  if (!skill) {
    return next({
      ...state,
      screen: "explore_skill",
      exploreTask: objective,
      exploreSkillInput: requested,
      selected: 0,
    });
  }
  return next({
    ...state,
    screen: objective ? "explore_review" : "explore_task",
    exploreSkill: skill,
    exploreSkillInput: "",
    exploreTask: objective,
    selected: 0,
  });
}

function availableExploreSkills(
  state: EvaluationTuiState
): XiaobaSkillDescriptor[] {
  const roleId = state.exploreRole?.id;
  const applicable = state.xiaobaSkills.filter(
    (skill) =>
      skill.scope === "base" ||
      (skill.scope === "role" && skill.role_id === roleId)
  );
  const byId = new Map<string, XiaobaSkillDescriptor>();
  for (const skill of applicable) {
    const key = skill.id.toLowerCase();
    const current = byId.get(key);
    if (!current || skill.scope === "role") byId.set(key, skill);
  }
  return [...byId.values()].sort(
    (left, right) =>
      left.display_name.localeCompare(right.display_name) ||
      left.id.localeCompare(right.id)
  );
}

function visibleExploreSkills(
  state: EvaluationTuiState
): XiaobaSkillDescriptor[] {
  const query = state.exploreSkillInput.trim().toLowerCase();
  const skills = availableExploreSkills(state);
  if (!query) return skills;
  return skills.filter((skill) =>
    [skill.id, skill.display_name, skill.description ?? ""].some((value) =>
      value.toLowerCase().includes(query)
    )
  );
}

function resolveExploreSkill(
  requested: string,
  skills: XiaobaSkillDescriptor[]
): XiaobaSkillDescriptor | undefined {
  const normalized = requested.trim().toLowerCase();
  const exact = skills.filter(
    (skill) =>
      skill.id.toLowerCase() === normalized ||
      skill.display_name.toLowerCase() === normalized
  );
  return exact.length === 1 ? exact[0] : undefined;
}

function resolveExploreRole(
  requested: string,
  roles: XiaobaRoleDescriptor[]
): XiaobaRoleDescriptor | undefined {
  const normalized = requested.trim().toLowerCase();
  const exact = roles.filter((role) =>
    [role.id, role.display_name, ...(role.aliases ?? [])]
      .map((value) => value.toLowerCase())
      .includes(normalized)
  );
  return exact.length === 1 ? exact[0] : resolveRoleFromIntent(requested, roles);
}

export function resolveAutomaticExploreTarget(
  runtimes: LocalRuntimeDescriptor[],
  roles: XiaobaRoleDescriptor[]
): {
  runtime?: LocalRuntimeDescriptor;
  role?: XiaobaRoleDescriptor;
  runtimeIndex: number;
} {
  const ready = runtimes
    .map((runtime, index) => ({ runtime, index }))
    .filter(({ runtime }) => runtime.explore_support === "ready");
  if (ready.length !== 1 || ready[0].runtime.id !== "xiaobaos") {
    return { runtimeIndex: ready[0]?.index ?? 0 };
  }
  const role = roles.find((candidate) => candidate.base_profile)
    ?? (roles.length === 1 ? roles[0] : undefined);
  return {
    runtime: ready[0].runtime,
    ...(role && { role }),
    runtimeIndex: ready[0].index,
  };
}

export function resolveRoleFromIntent(
  intent: string,
  roles: XiaobaRoleDescriptor[]
): XiaobaRoleDescriptor | undefined {
  if (roles.length === 1) return roles[0];
  const scored = rankRolesForIntent(intent, roles);
  if (!scored.length || scored[0].score === scored[1]?.score) {
    return undefined;
  }
  return scored[0].role;
}

function roleCandidatesFromIntent(
  intent: string,
  roles: XiaobaRoleDescriptor[]
): XiaobaRoleDescriptor[] {
  const scored = rankRolesForIntent(intent, roles);
  if (!scored.length) return roles;
  const topScore = scored[0].score;
  return scored
    .filter((candidate) => candidate.score === topScore)
    .map((candidate) => candidate.role);
}

function rankRolesForIntent(
  intent: string,
  roles: XiaobaRoleDescriptor[]
): Array<{ role: XiaobaRoleDescriptor; score: number }> {
  const haystack = normalizeIntentText(intent);
  return roles
    .map((role) => {
      let score = 0;
      for (const label of [
        role.id,
        role.display_name,
        ...(role.aliases ?? []),
      ]) {
        const needle = normalizeIntentText(label);
        if (needle.length < 3) continue;
        if (haystack.includes(needle)) {
          score = Math.max(score, 1_000 + needle.length);
          continue;
        }
        if (
          needle.length >= 4 &&
          /[^\u0000-\u007f]/.test(needle) &&
          minimumSubstringDistance(haystack, needle) <= 1
        ) {
          score = Math.max(score, 500 + needle.length);
        }
      }
      return {
        role,
        score: score + rolePronunciationHintScore(haystack, role),
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.role.display_name.localeCompare(right.role.display_name)
    );
}

function rolePronunciationHintScore(
  normalizedIntent: string,
  role: XiaobaRoleDescriptor
): number {
  const hints: Record<string, string[]> = {
    xuan: ["玄", "炫"],
    huang: ["黄"],
  };
  return role.id
    .toLowerCase()
    .split(/[-_.]/)
    .reduce(
      (score, token) =>
        score +
        ((hints[token] ?? []).some((hint) =>
          normalizedIntent.includes(hint)
        )
          ? 100
          : 0),
      0
    );
}

function normalizeIntentText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function minimumSubstringDistance(haystack: string, needle: string): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const length of [needle.length - 1, needle.length, needle.length + 1]) {
    if (length < 1) continue;
    for (let index = 0; index <= haystack.length - length; index += 1) {
      minimum = Math.min(
        minimum,
        levenshtein(haystack.slice(index, index + length), needle)
      );
      if (minimum === 0) return 0;
    }
  }
  return minimum;
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex];
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function beginExploreRun(
  state: EvaluationTuiState
): EvaluationTuiTransition {
  if (
    state.exploreRuntime?.id !== "xiaobaos" ||
    !state.exploreRole ||
    !state.exploreTask
  ) {
    return next({
      ...state,
      screen: "error",
      error: "Barena could not build a complete Explore plan.",
      errorReturnScreen: "home",
    });
  }
  return effect(
    {
      ...state,
      screen: "explore_running",
      exploreResult: undefined,
      exploreProgress: [],
      exploreDetails: false,
      exploreConfirmInput: "",
    },
    {
      type: "run_explore",
      runtime: "xiaobaos",
      role: state.exploreRole.id,
      ...(state.exploreSkill && { skill: state.exploreSkill.id }),
      task: state.exploreTask,
      maxTurns: state.exploreMaxTurns,
      timeoutMs: state.exploreTimeoutMs,
      ...(state.exploreModel && { model: state.exploreModel }),
    }
  );
}

function begin(
  state: EvaluationTuiState,
  runtime: EvaluationRuntime,
  capability: EvaluationCapability
): EvaluationTuiTransition {
  return next({
    ...state,
    runtime,
    capability,
    screen: runtime === "xiaoba" ? "baseline_role" : "candidate",
    baselineRole: "",
    candidateInput: "",
    targetCommand: "",
    portableRuntime: undefined,
    candidateName: undefined,
    casePath: "",
    caseId: undefined,
    result: undefined,
    resultRoot: undefined,
    traceEvents: [],
    error: undefined,
    errorReturnScreen: undefined,
  });
}

function activateProductHomeItem(
  state: EvaluationTuiState,
  selected: number
): EvaluationTuiTransition {
  if (selected === 0) {
    const target = resolveAutomaticExploreTarget(
      state.runtimes,
      state.xiaobaRoles
    );
    return next({
      ...state,
      screen: target.role
        ? "explore_task"
        : target.runtime
          ? "explore_role"
          : "explore_runtime",
      selected: target.runtime ? 0 : target.runtimeIndex,
      exploreRuntime: target.runtime,
      exploreRole: target.role,
      exploreSkill: undefined,
      exploreSkillInput: "",
      exploreTask: "",
      exploreResult: undefined,
      error: undefined,
      errorReturnScreen: undefined,
    });
  }
  if (selected === 1) {
    return next({ ...state, selected });
  }
  if (selected === 2) {
    return next({ ...state, selected });
  }
  return next(state);
}

function activateSkillHomeItem(
  state: EvaluationTuiState,
  selected: number
): EvaluationTuiTransition {
  if (selected === 0) return begin({ ...state, selected }, "xiaoba", "skill");
  if (selected === 1) return begin({ ...state, selected }, "openclaw", "skill");
  if (selected === 2) return begin({ ...state, selected }, "portable", "skill");
  if (selected === 3) return next({
    ...state,
    selected,
    screen: "error",
    error: "Role A/B is temporarily held while Barena migrates it to ordinary target execution; XiaobaOS Arena fallback is disabled.",
    errorReturnScreen: state.homeMode === "product" ? "skill_home" : "home",
  });
  if (selected === 4) return next({ ...state, screen: "dag", selected: 0 });
  if (selected === 5) return next({ ...state, screen: "previous", selected: 0 });
  if (selected === 6) return next({ ...state, screen: "prerequisites", selected: 0 });
  return effect(state, { type: "quit" });
}

function normalizeInput(value: string): string {
  let normalized = value.trim();
  if (normalized.length >= 2) {
    const first = normalized[0];
    const last = normalized[normalized.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      normalized = normalized.slice(1, -1);
    }
  }
  return normalized.replace(/\\ /g, " ");
}

function appendText(current: string, value: string | undefined): string {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return current;
  return current + value;
}

function wrap(index: number, length: number): number {
  return (index + length) % length;
}

function next(state: EvaluationTuiState): EvaluationTuiTransition {
  return { state, effect: { type: "none" } };
}

function effect(state: EvaluationTuiState, value: EvaluationTuiEffect): EvaluationTuiTransition {
  return { state, effect: value };
}
