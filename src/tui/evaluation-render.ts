import figlet from "figlet";
import { AnyEvaluationResult, EvaluationTuiState, TraceViewEvent } from "./evaluation-model";

export interface EvaluationRenderOptions {
  width?: number;
  height?: number;
  color?: boolean;
}

const GOLD = "\x1b[38;5;220m";
// Regular copy deliberately uses the terminal's own foreground color. A fixed
// cream such as xterm-230 disappears on common light terminal themes.
const DEFAULT_FOREGROUND = "";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export function renderEvaluationTui(state: EvaluationTuiState, options: EvaluationRenderOptions = {}): string {
  const width = Math.max(20, options.width ?? process.stdout.columns ?? 100);
  const height = Math.max(12, options.height ?? process.stdout.rows ?? 30);
  const color = options.color ?? true;
  if (width < 40) {
    return paint("BARENA\n\nTerminal too narrow. Resize to at least 40 columns.\n\nq quit", DEFAULT_FOREGROUND, color);
  }
  const showHero = width >= 54 && (state.screen === "home" || height >= 34);
  const masthead = showHero ? heroMasthead(width, color) : compactMasthead(color);
  const body = screenBody(state, width - 6, height - masthead.length - 7, color);
  const progress = paint(
    width < 58
      ? "pair → arena → evidence → gate"
      : "select  →  pair  →  XiaoBa Arena  →  verify evidence  →  compare  →  gate",
    DIM,
    color
  );
  return [...masthead, progress, "", frame(body, width, color), "", footer(state, color)].join("\n");
}

function heroMasthead(width: number, color: boolean): string[] {
  const ascii = figlet
    .textSync("BARENA", {
      font: "ANSI Shadow",
      horizontalLayout: "default",
      verticalLayout: "default",
    })
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  return [
    paint(center("AGENTS CAN GROW.", width), DIM, color),
    "",
    ...ascii.map((line) => paint(center(line, width), GOLD, color)),
    "",
    paint(center("MAKES GROWTH REVIEWABLE.", width), DEFAULT_FOREGROUND, color),
    paint(center("AGENT CAPABILITY RELEASE CI", width), DIM, color),
  ];
}

function compactMasthead(color: boolean): string[] {
  return [`${paint("BARENA", `${BOLD}${GOLD}`, color)}  ${paint("AGENT CAPABILITY RELEASE CI", DIM, color)}`];
}

function screenBody(state: EvaluationTuiState, width: number, height: number, color: boolean): string[] {
  if (state.screen === "home") {
    return [
      heading("What do you want to verify?", color),
      "",
      ...menu([
        "Evaluate a Skill in XiaoBa-CLI",
        "Evaluate a Role in XiaoBa-CLI",
        "Evaluate a Skill in OpenClaw",
        "How Barena works (core DAG)",
        "Previous evaluations",
        "Prerequisites",
        "Quit",
      ], state.selected, color),
      "",
      paint("XiaoBa Skill: same Role without/with Skill. XiaoBa Role: explicit baseline/candidate Role.", DIM, color),
    ];
  }
  if (state.screen === "dag") return dagBody(width, color);
  if (state.screen === "baseline_role") {
    return inputScreen(
      "Baseline Role",
      state.capability === "skill"
        ? "Installed XiaoBa Role ID used for both arms"
        : "Installed XiaoBa Role ID used as the explicit baseline",
      state.baselineRole,
      color
    );
  }
  if (state.screen === "candidate") {
    return inputScreen(
      state.capability === "skill" ? "Candidate Skill" : "Candidate Role",
      state.capability === "skill" ? "Path to a directory containing SKILL.md" : "Installed XiaoBa Role ID",
      state.candidateInput,
      color
    );
  }
  if (state.screen === "target") {
    return [heading("Target runtime", color), "", paint("› OpenClaw", GOLD, color), "", "Phase 1 target.", "Candidate: exact Skill allowlist.", "Baseline: empty Skill allowlist.", "", paint("Enter continue   Esc back", DIM, color)];
  }
  if (state.screen === "case") return inputScreen(
    "E2E case",
    state.runtime === "xiaoba"
      ? "Path to a barena.xiaoba_native_case.v1 JSON file"
      : "Path to a barena.agent_e2e_case.v1 JSON file",
    state.casePath,
    color
  );
  if (state.screen === "review") {
    const isNative = state.runtime === "xiaoba";
    return [
      heading("Review paired evaluation", color), "",
      row(state.capability === "skill" ? "Skill" : "Role", `${state.candidateName ?? "candidate"}  (${state.candidateInput})`),
      row("Target", isNative ? "XiaoBa-CLI native Arena" : "OpenClaw (external adapter)"),
      row("Case", `${state.caseId ?? "case"}  (${state.casePath})`),
      row("Baseline", isNative ? state.baselineRole : "no Skill"),
      row("Candidate", state.capability === "skill"
        ? (isNative ? `${state.baselineRole} + selected Skill` : "selected Skill only")
        : state.candidateInput),
      row("Attempts", `${state.attempts} per arm / ${state.attempts * 2} total`),
      "",
      paint("←/→ attempts   Enter run   Esc back", DIM, color),
    ];
  }
  if (state.screen === "running") {
    return [
      heading("Evaluation running", color), "",
      state.runtime === "xiaoba"
        ? "XiaoBa native probe → isolated baseline → isolated candidate → native trace + verifier → release gate"
        : "XiaoBa evaluator preflight → OpenClaw baseline → candidate → verifier → release gate",
      "",
      paint("Blocked prerequisites are persisted honestly; no deterministic fallback is used.", DIM, color),
    ];
  }
  if (state.screen === "result" && state.result) return resultBody(state, color);
  if (state.screen === "trace") return traceBody(state, width, height, color);
  if (state.screen === "previous") {
    if (!state.previous.length) return [heading("Previous evaluations", color), "", "No persisted Skill evaluations found."];
    return [heading("Previous evaluations", color), "", ...state.previous.map((item, index) => {
      const result = item.result;
      const candidate = resultCandidateName(result);
      return `${index === state.selected ? paint("›", GOLD, color) : " "} ${candidate.padEnd(20)} ${result.decision.padEnd(9)} ${result.reason_code}`;
    })];
  }
  if (state.screen === "prerequisites") {
    return [
      heading("Prerequisites", color), "",
      "1. XiaoBa-CLI 0.1.1 with native Arena", "2. Installed XiaoBa Roles and a local Skill or candidate Role", "3. Runtime credentials required by the selected model", "4. A native E2E case with artifact assertions", "5. OpenClaw only for the secondary external-runtime path", "",
      paint("Missing prerequisites yield held / blocked. Barena never substitutes a fake success path.", DIM, color),
    ];
  }
  if (state.screen === "error") return [heading("Cannot continue", color), "", state.error ?? "Unknown error", "", paint("Enter return home", DIM, color)];
  return [heading("Barena", color)];
}

function resultBody(state: EvaluationTuiState, color: boolean): string[] {
  const result = state.result!;
  const percent = (value: number | null): string => value === null ? "unavailable" : `${Math.round(value * 100)}%`;
  const native = result.schema === "barena.xiaoba_capability_evaluation_result.v1";
  const backed = result.outcome_truth.verifier_backed_attempts;
  const total = "total_observed_attempts" in result.outcome_truth
    ? result.outcome_truth.total_observed_attempts
    : result.outcome_truth.total_planned_attempts;
  return [
    `${heading("Release decision", color)}  ${decision(result.decision, color)}`, "",
    row("Runtime", native ? "XiaoBa-CLI native Arena" : "OpenClaw via XiaoBa evaluator"),
    row("Truth", `${result.outcome_truth.status} (${backed}/${total} verifier-backed)`),
    row("Effectiveness", `${result.effectiveness.status}; lift ${percent(result.effectiveness.observed_lift)}`),
    row("Baseline", `${percent(result.effectiveness.baseline_pass_rate.value)} / ${result.quality.baseline}`),
    row("Candidate", `${percent(result.effectiveness.candidate_pass_rate.value)} / ${result.quality.candidate}`),
    row("Quality", result.quality.required_evidence_complete ? "required evidence complete" : "required evidence incomplete"),
    row("Native trace", native
      ? (result.evidence_refs.some((ref) => ref.includes("native")) ? "available" : "missing (blocks completeness)")
      : (result.quality.target_native_trace_available ? "available" : "not available (external boundary only)")),
    ...(native ? [
      row("Evaluator stages", "XiaoBa Arena stages; not three independent AgentSessions"),
      row("Process isolation", "evaluator and target are not process-isolated"),
      row("Network policy", "disabled is declared; not a proven hard boundary"),
    ] : []),
    row("Reason", result.reason_code), "", result.summary, "",
    paint("t / Enter trace   h home   q quit", DIM, color),
  ];
}

function traceBody(state: EvaluationTuiState, width: number, height: number, color: boolean): string[] {
  if (!state.traceEvents.length) {
    return [heading("End-to-end trace", color), "", "No boundary trace: target was not started.", "", paint("This usually means XiaoBa or OpenClaw preflight blocked the run.", DIM, color)];
  }
  const availableRows = Math.max(3, height - 4);
  const events = state.traceEvents.slice(state.traceOffset, state.traceOffset + availableRows);
  return [heading(`End-to-end boundary trace  ${state.traceOffset + 1}-${state.traceOffset + events.length}/${state.traceEvents.length}`, color), "", ...events.flatMap((event) => renderEvent(event, width, color))];
}

function dagBody(width: number, color: boolean): string[] {
  const title = heading("Barena core evaluation DAG", color);
  if (width < 52) {
    const blockWidth = 34;
    const diagram = [
      "              UserCat",
      "                 ↓",
      "              Target",
      "         ┌───────┴───────┐",
      "         ↓               ↓",
      "       Trace         Artifacts",
      "         ↓               ↓",
      "     Inspector         Verifier",
      "         ↓               │",
      "     Reviewer            │",
      "         └───────┬───────┘",
      "                 ↓",
      "         Evidence package",
      "                 ↓",
      "          Compare → Gate",
    ].map((line) => center(pad(line, blockWidth), width));
    return [
      title,
      "",
      center("Baseline + Candidate + Cases", width),
      center("↓", width),
      center("Pair + clean attempts", width),
      center("↓", width),
      ...diagram,
      "",
      paint("Logical stages only.", DIM, color),
      paint("XiaoBa 0.1.1: composite pipeline.", DIM, color),
      paint("Not 3 independent AgentSessions.", DIM, color),
    ];
  }
  const blockWidth = 64;
  const diagram = [
    "                             UserCat",
    "                                ↓",
    "                       Target AgentSession",
    "                    ┌───────────┴───────────┐",
    "                    ↓                       ↓",
    "                E2E Trace        Artifacts + final state",
    "                    ↓                       ↓",
    "              InspectorCat              Verifier",
    "                    ↓                       │",
    "               ReviewerCat                  │",
    "                    └───────────┬───────────┘",
    "                                ↓",
    "                Validated + hash-stamped evidence",
    "                                ↓",
    "             Truth + lift + stability + regressions",
    "                                ↓",
  ].map((line) => center(pad(line, blockWidth), width));
  return [
    title,
    "",
    center("Baseline + Candidate + E2E Cases", width),
    center("↓", width),
    center("Fail-closed preflight + fresh paired attempts", width),
    center("↓", width),
    ...diagram,
    center(paint("CLEARED / HELD / REJECTED", GOLD, color), width),
    "",
    paint("Logical stages only: XiaoBa 0.1.1 uses one composite Arena pipeline,", DIM, color),
    paint("not three independent evaluator AgentSessions.", DIM, color),
  ];
}

function renderEvent(event: TraceViewEvent, width: number, color: boolean): string[] {
  const prefix = `${event.arm}/${event.attempt_id}  ${event.kind}  ${event.recorded_by}:${event.layer}/${event.observed_from}`;
  return [paint(prefix, GOLD, color), ...wrapText(event.message, width).map((line) => `  ${line}`)];
}

function inputScreen(title: string, hint: string, value: string, color: boolean): string[] {
  return [heading(title, color), "", hint, "", `${paint(">", GOLD, color)} ${value}${paint("▌", GOLD, color)}`, "", paint("Enter continue   Esc back", DIM, color)];
}

function frame(lines: string[], width: number, color: boolean): string {
  const inner = width - 4;
  const top = `╭${"─".repeat(width - 2)}╮`;
  const bottom = `╰${"─".repeat(width - 2)}╯`;
  const rows = lines.flatMap((line) => wrapText(line, inner)).map((line) => `│ ${pad(line, inner)} │`);
  return paint([top, ...rows, bottom].join("\n"), DEFAULT_FOREGROUND, color);
}

function menu(items: string[], selected: number, color: boolean): string[] {
  return items.map((item, index) => `${index === selected ? paint("›", GOLD, color) : " "} ${item}`);
}

function heading(value: string, color: boolean): string { return paint(value, BOLD, color); }
function row(label: string, value: string): string { return `${label.padEnd(16)} ${value}`; }
function decision(value: string, color: boolean): string { return paint(value.toUpperCase(), value === "cleared" ? "\x1b[38;5;82m" : value === "rejected" ? "\x1b[38;5;196m" : GOLD, color); }
function footer(state: EvaluationTuiState, color: boolean): string { return paint(state.screen === "home" ? "↑/↓ choose   Enter select   q quit" : "Esc back   q quit", DIM, color); }
function paint(value: string, code: string, color: boolean): string { return color && code ? `${code}${value}${RESET}` : value; }
function stripAnsi(value: string): string { return value.replace(/\x1b\[[0-9;]*m/g, ""); }
function pad(value: string, width: number): string { return value + " ".repeat(Math.max(0, width - stripAnsi(value).length)); }
function center(value: string, width: number): string {
  const length = stripAnsi(value).length;
  return length >= width ? value.slice(0, width) : `${" ".repeat(Math.floor((width - length) / 2))}${value}`;
}

function wrapText(value: string, width: number): string[] {
  if (stripAnsi(value).length <= width) return [value];
  const plain = stripAnsi(value);
  const lines: string[] = [];
  for (let index = 0; index < plain.length; index += width) lines.push(plain.slice(index, index + width));
  return lines;
}

function resultCandidateName(result: AnyEvaluationResult): string {
  if (result.schema === "barena.skill_evaluation.v1") {
    return result.candidate.selection.mode === "path" ? result.candidate.selection.name : "candidate";
  }
  return result.candidate.selection.mode === "role_skill"
    ? result.candidate.selection.skill.name
    : result.candidate.selection.role.role_id;
}
