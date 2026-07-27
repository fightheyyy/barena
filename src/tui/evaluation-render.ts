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
    return paint("BARENA\n\nTerminal too narrow.\nNeed 40+ columns.\n\nq quit", DEFAULT_FOREGROUND, color);
  }
  const showHero = state.screen === "home" && width >= 72 && height >= 34;
  const masthead = showHero ? heroMasthead(width, color) : compactMasthead(color);
  const bodyHeight = Math.max(3, height - masthead.length - 6);
  const body = screenBody(state, width - 6, bodyHeight, color);
  return [
    ...masthead,
    workflowProgress(state, width, color),
    "",
    frame(body, width, bodyHeight, color),
    "",
    footer(state, color),
  ].join("\n");
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
    const descriptions = [
      "Same-Role Skill comparison through XiaobaOS ordinary chat.",
      "Built-in OpenClaw adapter with boundary/workspace verification.",
      "Hermes or custom CLI through Barena's portable JSON contract.",
      "Role A/B (temporarily held during ordinary-target migration).",
      "Evaluation stages and the evidence-to-release path.",
      "Open a persisted decision and its trace.",
      "Files, runtimes, and safety policy required before execution.",
      "Exit without changing files.",
    ];
    const items = [
      "XiaobaOS Skill (recommended)",
      "OpenClaw Skill",
      "Hermes/custom Skill",
      "XiaobaOS Role",
      "How Barena works",
      "Previous runs",
      "Prerequisites",
      "Quit",
    ];
    if (width < 50) {
      const compactDescriptions = [
        "ordinary chat + verifier",
        "portable boundary evidence",
        "portable JSON driver",
        "Role A/B migration held",
        "evaluation DAG",
        "saved decisions + traces",
        "setup checklist",
        "no changes",
      ];
      return [
        heading("Run an agent evaluation", color),
        "Choose what changed.",
        paint("Import/setup: `barena guide`", DIM, color),
        "",
        ...menu(items, state.selected, color),
        "",
        `${paint("Selected", `${BOLD}${GOLD}`, color)}  ${compactDescriptions[state.selected]}`,
      ];
    }
    return [
      heading("Run an agent evaluation", color),
      "Choose what changed and where it should run.",
      paint("Need import or a starter case? Use `barena guide`.", DIM, color),
      "",
      ...menu(items, state.selected, color),
      "",
      `${paint("Selected", `${BOLD}${GOLD}`, color)}  ${descriptions[state.selected]}`,
    ];
  }
  if (state.screen === "dag") return dagBody(width, height, color);
  if (state.screen === "baseline_role") {
    return inputScreen(
      "Baseline Role",
      state.capability === "skill"
        ? "Installed Role ID used in both baseline and candidate arms."
        : "Installed Role ID used as the explicit baseline.",
      "Example: engineer-cat",
      state.baselineRole,
      color
    );
  }
  if (state.screen === "candidate") {
    return inputScreen(
      state.capability === "skill" ? "Candidate Skill" : "Candidate Role",
      state.capability === "skill" ? "Local directory containing SKILL.md." : "Installed XiaobaOS Role ID.",
      state.capability === "skill" ? "Example: ./my-skill" : "Example: engineer-cat-v2",
      state.candidateInput,
      color
    );
  }
  if (state.screen === "target") {
    return [
      heading("Target runtime", color),
      "",
      `${paint("Selected", `${BOLD}${GOLD}`, color)}  OpenClaw built-in adapter`,
      "A fresh session and workspace are created for every attempt.",
      "Evidence: boundary + workspace + verifier; no native trace claim.",
    ];
  }
  if (state.screen === "target_command") {
    return inputScreen(
      "Portable target driver",
      "Executable implementing Barena's portable JSON driver contract.",
      "Example: ./bin/hermes-barena-driver",
      state.targetCommand,
      color
    );
  }
  if (state.screen === "case") {
    return inputScreen(
      "E2E case",
      state.runtime === "xiaoba"
        ? "JSON file with schema barena.agent_e2e_case.v1 and target.adapter=xiaoba."
        : "JSON file with schema barena.agent_e2e_case.v1.",
      "Example: ./cases/release-smoke.json",
      state.casePath,
      color
    );
  }
  if (state.screen === "review") {
    const isNative = state.runtime === "xiaoba";
    return [
      heading("Review paired evaluation", color),
      "",
      row(state.capability === "skill" ? "Skill" : "Role", `${state.candidateName ?? "candidate"}  (${state.candidateInput})`),
      row("Target", runtimeLabel(state)),
      row("Case", `${state.caseId ?? "case"}  (${state.casePath})`),
      row("Baseline", isNative ? state.baselineRole : "no Skill"),
      row("Candidate", state.capability === "skill"
        ? (isNative ? `${state.baselineRole} + selected Skill` : "selected Skill only")
        : state.candidateInput),
      row("Sessions", `${state.attempts * 2} total (${state.attempts} baseline + ${state.attempts} candidate)`),
      row("Evidence", evidenceLabel(state)),
      "",
      paint("Execution may call paid models. Enter opens a separate confirmation.", GOLD, color),
    ];
  }
  if (state.screen === "confirm") {
    return [
      heading("Start model-backed evaluation?", color),
      "",
      row("Target", runtimeLabel(state)),
      row("Sessions", `${state.attempts * 2} total`),
      row("Evidence", evidenceLabel(state)),
      row("Writes", "a new persisted run under runs/"),
      "",
      paint("This may incur provider cost. Press y to start; Enter does nothing.", GOLD, color),
    ];
  }
  if (state.screen === "running") {
    return [
      heading("Evaluation running", color),
      "",
      state.runtime === "xiaoba"
        ? "XiaobaOS chat probe → isolated baseline → isolated candidate → boundary/optional native trace + verifier → release gate"
        : `${runtimeLabel(state)} probe → fresh baseline/candidate attempts → boundary/workspace verifier → release gate`,
      "",
      `Planned target sessions: ${state.attempts * 2}. Keep this terminal open.`,
      paint("Blocked prerequisites are persisted honestly; no fake fallback is used.", DIM, color),
    ];
  }
  if (state.screen === "result" && state.result) return resultBody(state, color);
  if (state.screen === "trace") return traceBody(state, width, height, color);
  if (state.screen === "previous") {
    if (!state.previous.length) {
      return [
        heading("Previous runs", color),
        "",
        "No persisted Skill or Role evaluations found.",
        "",
        "Complete an evaluation, then return here to inspect its decision and trace.",
      ];
    }
    return [heading("Previous evaluations", color), "", ...state.previous.map((item, index) => {
      const result = item.result;
      const candidate = resultCandidateName(result);
      return `${index === state.selected ? paint("›", GOLD, color) : " "} ${candidate}  ${result.decision.toUpperCase()}  ${result.reason_code}`;
    })];
  }
  if (state.screen === "prerequisites") {
    return [
      heading("Prerequisites", color),
      "",
      "1. Local candidate Skill directory containing SKILL.md",
      "2. Deterministic E2E case and artifact assertions",
      "3. XiaobaOS ordinary chat CLI + an installed Role",
      "4. OpenClaw binary for the built-in portable adapter",
      "5. Executable JSON driver for Hermes/custom agents",
      "",
      paint("Missing prerequisites yield held / blocked. Barena never substitutes a fake success path.", DIM, color),
    ];
  }
  if (state.screen === "error") {
    return [
      heading("Fix this step", color),
      "",
      state.error ?? "Unknown error",
      "",
      paint("Your previous inputs are preserved. Enter returns to the step; h goes home.", DIM, color),
    ];
  }
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
    `${heading("Release decision", color)}  ${decision(result.decision, color)}`,
    result.summary,
    "",
    row("Runtime", runtimeLabel(state)),
    row("Truth", `${result.outcome_truth.status} (${backed}/${total} verifier-backed)`),
    row("Baseline", `${percent(result.effectiveness.baseline_pass_rate.value)} / ${result.quality.baseline}`),
    row("Candidate", `${percent(result.effectiveness.candidate_pass_rate.value)} / ${result.quality.candidate}`),
    row("Observed lift", percent(result.effectiveness.observed_lift)),
    row("Evidence", native
      ? (result.quality.required_evidence_complete ? "native + verifier evidence complete" : "native evidence incomplete")
      : "boundary_verified; policy_only; confidence ≤ medium"),
    row("Reason", result.reason_code),
    "",
    paint("Next: inspect trace, or edit the same setup and rerun.", DIM, color),
  ];
}

function traceBody(state: EvaluationTuiState, width: number, height: number, color: boolean): string[] {
  if (!state.traceEvents.length) {
    return [
      heading("End-to-end trace", color),
      "",
      "No boundary trace: target was not started.",
      "",
      paint("This usually means XiaobaOS or portable-target preflight blocked the run.", DIM, color),
    ];
  }
  const availableRows = Math.max(3, height - 2);
  const lines: string[] = [];
  let eventCount = 0;
  for (const event of state.traceEvents.slice(state.traceOffset)) {
    const rendered = renderEvent(event, width, color);
    if (lines.length > 0 && lines.length + rendered.length > availableRows) break;
    lines.push(...rendered);
    eventCount += 1;
    if (lines.length >= availableRows) break;
  }
  return [
    heading(`End-to-end trace  ${state.traceOffset + 1}-${state.traceOffset + eventCount}/${state.traceEvents.length}`, color),
    "",
    ...lines,
  ];
}

function dagBody(width: number, height: number, color: boolean): string[] {
  const title = heading("Barena core evaluation DAG", color);
  if (width < 52 || height < 22) {
    return [
      title,
      "",
      center("Baseline + Candidate + Cases", width),
      center("↓", width),
      center("Fresh paired attempts", width),
      center("↓", width),
      center("UserCat → Target", width),
      center("↓", width),
      center("Trace + Artifacts", width),
      center("↓", width),
      center("Inspector + Verifier → Reviewer", width),
      center("↓", width),
      center("Evidence → Compare → Gate", width),
      "",
      paint("Barena owns evaluation; targets expose boundary evidence and may also emit genuine native traces.", DIM, color),
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
    paint("UserCat/Inspector/Reviewer are Barena evaluator stages; fixed replay currently uses", DIM, color),
    paint("deterministic case driving and verification rather than fabricating agent traces.", DIM, color),
  ];
}

function workflowProgress(state: EvaluationTuiState, width: number, color: boolean): string {
  if (["home", "dag", "previous", "prerequisites"].includes(state.screen)) {
    return paint(width < 58 ? "Choose workflow · guide imports" : "Choose workflow · local paths · `barena guide` imports/creates", DIM, color);
  }
  if (state.screen === "error") {
    return paint("Fix input · your values are preserved", DIM, color);
  }
  const native = state.result
    ? state.result.schema === "barena.xiaoba_capability_evaluation_result.v1"
    : state.runtime === "xiaoba";
  const labels = native
    ? ["Baseline", "Candidate", "Case", "Review", "Result"]
    : ["Candidate", "Target", "Case", "Review", "Result"];
  const active = workflowStep(state);
  if (width < 58) {
    const target = native
      ? "XiaobaOS"
      : runtimeLabel(state).startsWith("OpenClaw")
        ? "OpenClaw"
        : "portable";
    return `${paint(`[${active}/5]`, `${BOLD}${GOLD}`, color)} ${labels[active - 1]} · ${target}`;
  }
  return labels.map((label, index) => {
    const step = index + 1;
    const value = step === active ? `[${step} ${label}]` : `${step} ${label}`;
    return step === active ? paint(value, `${BOLD}${GOLD}`, color) : paint(value, DIM, color);
  }).join("  →  ");
}

function workflowStep(state: EvaluationTuiState): number {
  if (state.screen === "baseline_role") return 1;
  if (state.screen === "candidate") return state.runtime === "xiaoba" ? 2 : 1;
  if (state.screen === "target" || state.screen === "target_command") return 2;
  if (state.screen === "case") return 3;
  if (state.screen === "review" || state.screen === "confirm") return 4;
  return 5;
}

function runtimeLabel(state: EvaluationTuiState): string {
  if (state.result?.schema === "barena.xiaoba_capability_evaluation_result.v1") return "Legacy XiaobaOS Arena run (read-only)";
  if (state.result?.schema === "barena.skill_evaluation.v1") {
    const run = state.result.candidate.run_refs[0] ?? state.result.baseline.run_refs[0];
    const adapter = run?.scorecard.target.adapter;
    if (adapter === "xiaobaos") return "XiaobaOS ordinary chat adapter";
    if (adapter === "openclaw") return "OpenClaw portable verifier";
    if (adapter?.startsWith("portable:")) return `${adapter.slice("portable:".length)} via portable JSON driver`;
    if (state.runtime === "openclaw") return "OpenClaw portable verifier";
    if (state.runtime === "portable") return `${state.portableRuntime ?? "Hermes/custom"} via portable JSON driver`;
    return "Portable verifier (target unavailable)";
  }
  if (state.runtime === "xiaoba") return "XiaobaOS ordinary chat adapter";
  if (state.runtime === "openclaw") return "OpenClaw portable verifier";
  return `${state.portableRuntime ?? "Hermes/custom"} via portable JSON driver`;
}

function evidenceLabel(state: EvaluationTuiState): string {
  return state.runtime === "xiaoba"
    ? "boundary/workspace/verifier + optional genuine native trace"
    : "boundary/workspace/verifier; confidence ≤ medium";
}

function renderEvent(event: TraceViewEvent, width: number, color: boolean): string[] {
  const prefix = `${event.arm}/${event.attempt_id}  ${event.kind}  ${event.recorded_by}:${event.layer}/${event.observed_from}`;
  return [paint(prefix, GOLD, color), ...wrapText(event.message, width).map((line) => `  ${line}`)];
}

function inputScreen(title: string, hint: string, example: string, value: string, color: boolean): string[] {
  return [
    `${heading(title, color)}  ${paint("required", GOLD, color)}`,
    "",
    hint,
    paint(example, DIM, color),
    "",
    `${paint(">", GOLD, color)} ${value}${paint("▌", GOLD, color)}`,
  ];
}

function frame(lines: string[], width: number, maxRows: number, color: boolean): string {
  const inner = width - 4;
  const top = `╭${"─".repeat(width - 2)}╮`;
  const bottom = `╰${"─".repeat(width - 2)}╯`;
  const wrapped = lines.flatMap((line) => wrapText(line, inner));
  const visible = wrapped.slice(0, maxRows);
  if (wrapped.length > maxRows && visible.length > 0) {
    visible[visible.length - 1] = paint("… resize taller to see more", DIM, color);
  }
  const rows = visible.map((line) => `│ ${pad(line, inner)} │`);
  return paint([top, ...rows, bottom].join("\n"), DEFAULT_FOREGROUND, color);
}

function menu(items: string[], selected: number, color: boolean): string[] {
  return items.map((item, index) => `${index === selected ? paint("›", GOLD, color) : " "} ${index + 1}. ${item}`);
}

function heading(value: string, color: boolean): string { return paint(value, BOLD, color); }
function row(label: string, value: string): string { return `${label.padEnd(13)} ${value}`; }
function decision(value: string, color: boolean): string { return paint(value.toUpperCase(), value === "cleared" ? "\x1b[38;5;82m" : value === "rejected" ? "\x1b[38;5;196m" : GOLD, color); }
function footer(state: EvaluationTuiState, color: boolean): string {
  const value = state.screen === "home"
    ? "↑/↓ choose · Enter select · q quit"
    : ["baseline_role", "candidate", "target_command", "case"].includes(state.screen)
      ? "Enter next · ^U clear · Esc back"
      : state.screen === "review"
        ? "←/→ attempts · Enter · Esc back"
        : state.screen === "confirm"
          ? "y start · n/Esc cancel"
          : state.screen === "result"
            ? "t trace · e edit · h home · q quit"
            : state.screen === "trace"
              ? "↑/↓ scroll · b result · q quit"
              : state.screen === "error"
                ? "Enter retry · h home · q quit"
                : "Enter/Esc back · q quit";
  return paint(value, DIM, color);
}
function paint(value: string, code: string, color: boolean): string { return color && code ? `${code}${value}${RESET}` : value; }
function stripAnsi(value: string): string { return value.replace(/\x1b\[[0-9;]*m/g, ""); }
function pad(value: string, width: number): string { return value + " ".repeat(Math.max(0, width - stripAnsi(value).length)); }
function center(value: string, width: number): string {
  const length = stripAnsi(value).length;
  return length >= width ? stripAnsi(value).slice(0, width) : `${" ".repeat(Math.floor((width - length) / 2))}${value}`;
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
