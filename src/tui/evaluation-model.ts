import { SkillEvaluationResultV1 } from "../evaluation/types";
import { XiaoBaCapabilityEvaluationResultV1 } from "../evaluation/xiaoba-native-types";

export type EvaluationRuntime = "xiaoba" | "openclaw" | "portable";
export type EvaluationCapability = "skill" | "role";
export type AnyEvaluationResult = SkillEvaluationResultV1 | XiaoBaCapabilityEvaluationResultV1;

export type EvaluationTuiScreen =
  | "home"
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
  selected: number;
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
  | { type: "candidate_valid"; name: string }
  | { type: "case_valid"; caseId: string; targetRuntime?: string }
  | { type: "result"; result: AnyEvaluationResult; resultRoot?: string; traceEvents: TraceViewEvent[] }
  | { type: "error"; message: string; returnScreen?: EvaluationTuiScreen };

const HOME_ITEMS = 8;

export function initialEvaluationTuiState(previous: PreviousEvaluation[] = []): EvaluationTuiState {
  return {
    screen: "home",
    selected: 0,
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
  if (key === "q" && !["baseline_role", "candidate", "target_command", "case"].includes(state.screen)) {
    return effect(state, { type: "quit" });
  }

  if (state.screen === "home") {
    if (key === "up" || key === "k") return next({ ...state, selected: wrap(state.selected - 1, HOME_ITEMS) });
    if (key === "down" || key === "j") return next({ ...state, selected: wrap(state.selected + 1, HOME_ITEMS) });
    if (key && /^[1-8]$/.test(key)) return activateHomeItem(state, Number(key) - 1);
    if (key === "return") return activateHomeItem(state, state.selected);
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
      return next({ ...state, screen: "home", selected: 4 });
    }
    return next(state);
  }

  if (state.screen === "previous") {
    if (key === "escape" || key === "b") return next({ ...state, screen: "home", selected: 5 });
    if (key === "down" || key === "j") return next({ ...state, selected: wrap(state.selected + 1, Math.max(1, state.previous.length)) });
    if (key === "up" || key === "k") return next({ ...state, selected: wrap(state.selected - 1, Math.max(1, state.previous.length)) });
    if (key === "return" && state.previous[state.selected]) {
      const previous = state.previous[state.selected];
      return next({ ...state, screen: "result", result: previous.result, resultRoot: previous.run_root, traceEvents: [], traceOffset: 0 });
    }
    return next(state);
  }

  if (state.screen === "prerequisites") {
    if (key === "escape" || key === "b" || key === "return") return next({ ...state, screen: "home", selected: 6 });
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

function activateHomeItem(state: EvaluationTuiState, selected: number): EvaluationTuiTransition {
  if (selected === 0) return begin({ ...state, selected }, "xiaoba", "skill");
  if (selected === 1) return begin({ ...state, selected }, "openclaw", "skill");
  if (selected === 2) return begin({ ...state, selected }, "portable", "skill");
  if (selected === 3) return next({
    ...state,
    selected,
    screen: "error",
    error: "Role A/B is temporarily held while Barena migrates it to ordinary target execution; XiaobaOS Arena fallback is disabled.",
    errorReturnScreen: "home",
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
