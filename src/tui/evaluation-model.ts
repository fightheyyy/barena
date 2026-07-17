import { SkillEvaluationResultV1 } from "../evaluation/types";
import { XiaoBaCapabilityEvaluationResultV1 } from "../evaluation/xiaoba-native-types";

export type EvaluationRuntime = "xiaoba" | "openclaw";
export type EvaluationCapability = "skill" | "role";
export type AnyEvaluationResult = SkillEvaluationResultV1 | XiaoBaCapabilityEvaluationResultV1;

export type EvaluationTuiScreen =
  | "home"
  | "dag"
  | "baseline_role"
  | "candidate"
  | "target"
  | "case"
  | "review"
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
}

export interface EvaluationTuiState {
  screen: EvaluationTuiScreen;
  selected: number;
  runtime: EvaluationRuntime;
  capability: EvaluationCapability;
  baselineRole: string;
  candidateInput: string;
  candidateName?: string;
  casePath: string;
  caseId?: string;
  attempts: number;
  result?: AnyEvaluationResult;
  traceEvents: TraceViewEvent[];
  traceOffset: number;
  previous: PreviousEvaluation[];
  error?: string;
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
  | { type: "case_valid"; caseId: string }
  | { type: "result"; result: AnyEvaluationResult; traceEvents: TraceViewEvent[] }
  | { type: "error"; message: string };

const HOME_ITEMS = 7;

export function initialEvaluationTuiState(previous: PreviousEvaluation[] = []): EvaluationTuiState {
  return {
    screen: "home",
    selected: 0,
    runtime: "xiaoba",
    capability: "skill",
    baselineRole: "",
    candidateInput: "",
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
    const nextScreen: EvaluationTuiScreen = state.runtime === "openclaw" ? "target" : "case";
    return next({ ...state, screen: nextScreen, candidateName: action.name, selected: 0 });
  }
  if (action.type === "case_valid") {
    return next({ ...state, screen: "review", caseId: action.caseId, selected: 0 });
  }
  if (action.type === "result") {
    return next({ ...state, screen: "result", result: action.result, traceEvents: action.traceEvents, traceOffset: 0 });
  }
  if (action.type === "error") {
    return next({ ...state, screen: "error", error: action.message });
  }

  const key = action.name;
  if (action.ctrl && key === "c") return effect(state, { type: "quit" });
  if (key === "q" && !["baseline_role", "candidate", "case"].includes(state.screen)) return effect(state, { type: "quit" });

  if (state.screen === "home") {
    if (key === "up" || key === "k") return next({ ...state, selected: wrap(state.selected - 1, HOME_ITEMS) });
    if (key === "down" || key === "j") return next({ ...state, selected: wrap(state.selected + 1, HOME_ITEMS) });
    if (key === "return") {
      if (state.selected === 0) return begin(state, "xiaoba", "skill");
      if (state.selected === 1) return begin(state, "xiaoba", "role");
      if (state.selected === 2) return begin(state, "openclaw", "skill");
      if (state.selected === 3) return next({ ...state, screen: "dag", selected: 0 });
      if (state.selected === 4) return next({ ...state, screen: "previous", selected: 0 });
      if (state.selected === 5) return next({ ...state, screen: "prerequisites", selected: 0 });
      return effect(state, { type: "quit" });
    }
    return next(state);
  }

  if (state.screen === "baseline_role") {
    if (key === "escape") return next({ ...state, screen: "home", selected: 0 });
    if (key === "backspace") return next({ ...state, baselineRole: state.baselineRole.slice(0, -1) });
    if (key === "return" && state.baselineRole.trim()) return next({ ...state, screen: "candidate" });
    return next({ ...state, baselineRole: appendText(state.baselineRole, action.text) });
  }

  if (state.screen === "candidate") {
    if (key === "escape") {
      return next({ ...state, screen: state.runtime === "xiaoba" ? "baseline_role" : "home" });
    }
    if (key === "backspace") return next({ ...state, candidateInput: state.candidateInput.slice(0, -1) });
    if (key === "return" && state.candidateInput.trim()) {
      return effect(state, {
        type: "validate_candidate",
        runtime: state.runtime,
        capability: state.capability,
        value: state.candidateInput.trim(),
      });
    }
    return next({ ...state, candidateInput: appendText(state.candidateInput, action.text) });
  }

  if (state.screen === "target") {
    if (key === "escape") return next({ ...state, screen: "candidate" });
    if (key === "return") return next({ ...state, screen: "case", selected: 0 });
    return next(state);
  }

  if (state.screen === "case") {
    if (key === "escape") return next({ ...state, screen: state.runtime === "openclaw" ? "target" : "candidate" });
    if (key === "backspace") return next({ ...state, casePath: state.casePath.slice(0, -1) });
    if (key === "return" && state.casePath.trim()) {
      return effect(state, { type: "validate_case", runtime: state.runtime, path: state.casePath.trim() });
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
    if (key === "return") {
      return effect(
        { ...state, screen: "running" },
        {
          type: "run",
          runtime: state.runtime,
          capability: state.capability,
          baselineRole: state.baselineRole,
          candidateInput: state.candidateInput,
          casePath: state.casePath,
          attempts: state.attempts,
        }
      );
    }
    return next(state);
  }

  if (state.screen === "result") {
    if (key === "t" || key === "return") return next({ ...state, screen: "trace", traceOffset: 0 });
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
      return next({ ...state, screen: "home", selected: 3 });
    }
    return next(state);
  }

  if (state.screen === "previous") {
    if (key === "escape" || key === "b") return next({ ...state, screen: "home", selected: 4 });
    if (key === "down" || key === "j") return next({ ...state, selected: wrap(state.selected + 1, Math.max(1, state.previous.length)) });
    if (key === "up" || key === "k") return next({ ...state, selected: wrap(state.selected - 1, Math.max(1, state.previous.length)) });
    if (key === "return" && state.previous[state.selected]) {
      return next({ ...state, screen: "result", result: state.previous[state.selected].result, traceEvents: [], traceOffset: 0 });
    }
    return next(state);
  }

  if (state.screen === "prerequisites") {
    if (key === "escape" || key === "b" || key === "return") return next({ ...state, screen: "home", selected: 5 });
  }
  if (state.screen === "error") {
    if (key === "escape" || key === "b" || key === "return") return next({ ...state, screen: "home", selected: 0 });
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
    candidateName: undefined,
    casePath: "",
    caseId: undefined,
    result: undefined,
    traceEvents: [],
    error: undefined,
  });
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
