import figlet from "figlet";
import type { ExploreProgressEvent } from "../explore/types";
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
const SELECTED_MARKER = "\x1b[1;30;48;5;220m";
const RESET = "\x1b[0m";

export function renderEvaluationTui(state: EvaluationTuiState, options: EvaluationRenderOptions = {}): string {
  const width = Math.max(20, options.width ?? process.stdout.columns ?? 100);
  const height = Math.max(12, options.height ?? process.stdout.rows ?? 30);
  const color = options.color ?? true;
  if (width < 40) {
    return paint("BARENA\n\nTerminal too narrow.\nNeed 40+ columns.\n\nq quit", DEFAULT_FOREGROUND, color);
  }
  const showHero =
    state.screen === "home" &&
    width >= 72 &&
    height >= (state.homeMode === "product" ? 24 : 34);
  const masthead = showHero ? heroMasthead(width, color) : compactMasthead(color);
  const bodyHeight = Math.max(3, height - masthead.length - 4);
  const body = screenBody(state, width - 4, bodyHeight, color);
  return [
    ...masthead,
    workflowProgress(state, width, color),
    "",
    openCanvas(body, width, bodyHeight, color),
    "",
    footer(state, color, width),
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
    if (state.homeMode === "product") {
      const items =
        width < 58
          ? [
              "Explore unknown behavior",
              "Replay a Case  (CLI ready)",
              "Compare  (CLI ready)",
            ]
          : [
              "Explore unknown behavior",
              "Replay a known Case  (CLI ready)",
              "Compare releases  (CLI ready)",
            ];
      const descriptions = [
        "Let UserCat discover how a real user can push an Agent or Skill to its boundary.",
        "CLI ready: barena replay <case.json>. Interactive setup is next.",
        "CLI ready: barena compare <skill> --case <case.json>. Interactive setup is next.",
      ];
      return [
        heading("What are you evaluating today?", color),
        paint("Choose the job first. Barena will guide the rest.", DIM, color),
        "",
        ...menu(items, state.selected, color),
        "",
        `${paint("Selected", `${BOLD}${GOLD}`, color)}  ${
          descriptions[state.selected]
        }`,
      ];
    }
    return skillHomeBody(state, width, color);
  }
  if (state.screen === "skill_home") {
    return skillHomeBody(state, width, color);
  }
  if (state.screen === "explore_runtime") {
    const runtimes = state.runtimes;
    return [
      heading("Choose a local Agent Runtime", color),
      "",
      runtimes.length
        ? "Detected CLIs are listed separately from implemented adapters."
        : "No supported Agent Runtime CLI was detected on PATH.",
      "",
      ...(runtimes.length
        ? menu(
            runtimes.map(
              (runtime) =>
                `${runtime.display_name}  ${
                  runtime.explore_support === "ready"
                    ? "Explore ready"
                    : "adapter pending"
                }`
            ),
            state.selected,
            color
          )
        : [paint("Install or explicitly configure XiaoBaOS, then retry.", GOLD, color)]),
      "",
      ...(runtimes[state.selected]
        ? [
            row(
              "Command",
              runtimes[state.selected].command_path ??
                runtimes[state.selected].command_name
            ),
            row("Status", runtimes[state.selected].detail),
          ]
        : []),
    ];
  }
  if (state.screen === "explore_role") {
    const roles = state.xiaobaRoles;
    return [
      heading("Choose the XiaoBaOS Agent profile", color),
      "",
      "Base Agent is the explicit default. Evaluator Roles are hidden.",
      "",
      ...menuWindow(
        roles.map((role) =>
          role.base_profile
            ? `${role.display_name}  (default)`
            : `${role.display_name}  (${role.id})`
        ),
        state.selected,
        Math.max(3, height - 8),
        color
      ),
      "",
      ...(roles[state.selected]?.description
        ? [
            `${paint("Selected", `${BOLD}${GOLD}`, color)}  ${
              roles[state.selected].description
            }`,
          ]
        : []),
    ];
  }
  if (state.screen === "explore_task") {
    return [
      heading("What behavior should Barena test?", color),
      row(
        "Target",
        `${state.exploreRuntime?.display_name ?? "Runtime"} / ${
          state.exploreRole?.display_name ?? "Agent"
        }`
      ),
      row(
        "Focus",
        state.exploreRuntime?.id === "dsh"
          ? "Selected DSH profile"
          : state.exploreSkill
          ? `${state.exploreSkill.display_name} Skill`
          : "Entire Agent configuration"
      ),
      "",
      "Describe the user situation or behavior you want confidence in.",
      `${paint(" YOU ", SELECTED_MARKER, color)} ${state.exploreTask}${paint(
        "▌",
        BOLD,
        color
      )}`,
      "",
      paint(
        state.exploreRuntime?.id === "dsh"
          ? "DeepSeek Harness profile is the complete target."
          : state.exploreSkill
          ? "Use /skill clear to test the entire Agent instead."
          : "Optional: /agent <role-id> changes Agent · /skill focuses a Skill.",
        DIM,
        color
      ),
      paint(
        'Example: "Give it a vague deployment problem and see whether it clarifies before acting."',
        DIM,
        color
      ),
    ];
  }
  if (state.screen === "explore_skill") {
    const skills = applicableSkills(state);
    return [
      heading("Choose a Skill focus", color),
      row(
        "Host",
        `${state.exploreRuntime?.display_name ?? "Runtime"} / ${
          state.exploreRole?.display_name ?? "Agent"
        }`
      ),
      "",
      `${paint(" FILTER ", SELECTED_MARKER, color)} ${
        state.exploreSkillInput
      }${paint("▌", BOLD, color)}`,
      "",
      ...(skills.length
        ? menuWindow(
            skills.map(
              (skill) =>
                `${skill.display_name}  (${
                  skill.scope === "role" ? "Role" : "Base"
                })`
            ),
            state.selected,
            Math.max(3, height - 10),
            color
          )
        : [
            paint(
              state.exploreSkillInput
                ? "No matching installed Skill. Clear the filter and try again."
                : "No installed Skill is available for this Agent profile.",
              GOLD,
              color
            ),
          ]),
      "",
      paint(
        state.exploreTask
          ? "Your test objective is preserved; selecting a Skill returns to it."
          : "Select a Skill, then describe the behavior in the same Composer.",
        DIM,
        color
      ),
    ];
  }
  if (state.screen === "explore_review") {
    const role = state.exploreRole;
    return [
      heading("Ready to test", color),
      "",
      row(
        "Target",
        `${state.exploreRuntime?.display_name ?? "XiaoBaOS"} / ${
          state.exploreRuntime?.id === "dsh"
            ? "headless"
            : role ? `${role.display_name} (${role.id})` : "missing Role"
        }`
      ),
      row(
        "Focus",
        state.exploreRuntime?.id === "dsh"
          ? "Selected DSH profile"
          : state.exploreSkill
          ? `${state.exploreSkill.display_name} Skill`
          : "Entire Agent configuration"
      ),
      ...(state.exploreModel ? [row("Model", state.exploreModel)] : []),
      row("Objective", state.exploreTask),
      "",
      "Barena will simulate realistic users, inspect the execution evidence,",
      "and turn reproducible behavior gaps into Replay Case candidates.",
      "",
      paint(
        "Press Enter to start · this may call your configured model provider.",
        GOLD,
        color
      ),
    ];
  }
  if (state.screen === "explore_confirm") {
    return [
      heading("Start model-backed Explore?", color),
      "",
      row("Target", `${state.exploreRuntime?.display_name ?? "XiaoBaOS"} / ${state.exploreRuntime?.id === "dsh" ? "headless" : state.exploreRole?.id ?? "Role"}`),
      row("Maximum calls", String(state.exploreMaxTurns * 2 + 2)),
      row("Evidence", state.exploreRuntime?.id === "dsh" ? "Barena Turn span + DSH session refs" : "native OTLP required; missing evidence blocks the run"),
      row("Isolation", "fresh workspaces + Role/Skill snapshots; policy_only"),
      row("Writes", "a new persisted run under runs/"),
      "",
      paint("This may incur provider cost. Press y to start; Enter does nothing.", GOLD, color),
    ];
  }
  if (state.screen === "explore_running") {
    return exploreRunDashboard(state, width, color);
  }
  if (state.screen === "explore_result" && state.exploreResult) {
    const result = state.exploreResult;
    const issues =
      result.inspector.status === "completed"
        ? result.inspector.output.issues
        : [];
    const behavior = issues.filter((issue) => issue.severity !== "info");
    const diagnostics = issues.filter((issue) => issue.severity === "info");
    return [
      `${heading("Explore complete", color)}  ${exploreOutcome(result.status, color)}`,
      result.summary,
      "",
      row(
        "Evaluation",
        result.evidence.evidence_complete
          ? "complete · evidence retained"
          : "could not verify · evidence incomplete"
      ),
      row("Findings", `${behavior.length} behavior gap(s)`),
      ...behavior.slice(0, 2).map(
        (issue, index) => renderExploreFinding(issue, index)
      ),
      row(
        "Replay Cases",
        (result.replay_case_candidates?.length ?? 0)
          ? `${result.replay_case_candidates.length} candidate(s) ready`
          : "none generated"
      ),
      row(
        "Tested",
        result.scenario.target.skill
          ? `${result.scenario.target.skill} Skill`
          : `${
              result.runtime?.target_role ?? result.scenario.target.role
            } complete Agent configuration`
      ),
      ...(diagnostics.length
        ? [paint(`${diagnostics.length} diagnostic observation(s) kept in the report.`, DIM, color)]
        : []),
      "",
      paint(
        "c opens Replay Cases · v opens the conversation · the report keeps all evidence.",
        DIM,
        color
      ),
    ];
  }
  if (state.screen === "explore_cases" && state.exploreResult) {
    return exploreCasesBody(state, width, height, color);
  }
  if (state.screen === "explore_transcript" && state.exploreResult) {
    return exploreTranscriptBody(state, width, height, color);
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
      const selected = index === state.selected;
      const content = `${candidate}  ${result.decision.toUpperCase()}  ${result.reason_code}`;
      return `${selectionMarker(selected, color)} ${selected ? paint(content, BOLD, color) : content}`;
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

function skillHomeBody(
  state: EvaluationTuiState,
  width: number,
  color: boolean
): string[] {
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
      "Choose the target Runtime.",
      paint("Import/setup: `barena guide`", DIM, color),
      "",
      ...menu(items, state.selected, color),
      "",
      `${paint("Selected", `${BOLD}${GOLD}`, color)}  ${compactDescriptions[state.selected]}`,
    ];
  }
  return [
    heading("Run an agent evaluation", color),
    "Choose where the candidate Skill should run.",
    paint(
      state.homeMode === "product"
        ? "Esc returns to the Barena product home."
        : "Need import or a starter case? Use `barena guide`.",
      DIM,
      color
    ),
    "",
    ...menu(items, state.selected, color),
    "",
    `${paint("Selected", `${BOLD}${GOLD}`, color)}  ${descriptions[state.selected]}`,
  ];
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
  if (["home", "skill_home", "dag", "previous", "prerequisites"].includes(state.screen)) {
    return paint(
      state.screen === "home" && state.homeMode === "product"
        ? width < 58
          ? "[1/5] Task · choose the job"
          : "[1 Task]  →  2 Runtime  →  3 Agent  →  4 Objective  →  5 Confirm"
        : width < 58
          ? "Choose workflow · evidence first"
          : "Choose workflow · Explore unknowns · Replay known cases · Compare releases",
      DIM,
      color
    );
  }
  if (state.screen === "error") {
    return paint("Fix input · your values are preserved", DIM, color);
  }
  if (state.screen.startsWith("explore_")) {
    if (state.screen === "explore_running") {
      return paint(
        `Explore · ${state.exploreRole?.id ?? "target"} · Auto evidence budget`,
        DIM,
        color
      );
    }
    if (
      state.screen === "explore_result" ||
      state.screen === "explore_transcript"
    ) {
      return paint("Evaluation complete · inspect outcome and evidence", DIM, color);
    }
    if (state.screen === "explore_review") {
      return paint("1 Objective  →  [2 Start]  →  3 Result", DIM, color);
    }
    if (state.screen === "explore_role") {
      return paint("Resolve target  →  [Agent]  →  Objective", DIM, color);
    }
    if (state.screen === "explore_runtime") {
      return paint("[Runtime]  →  Agent  →  Objective", DIM, color);
    }
    if (state.screen === "explore_task" || state.screen === "explore_skill") {
      return paint("[1 Objective]  →  2 Start  →  3 Result", DIM, color);
    }
    return paint("Explore setup", DIM, color);
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

function applicableSkills(state: EvaluationTuiState) {
  const query = state.exploreSkillInput.trim().toLowerCase();
  const byId = new Map<string, EvaluationTuiState["xiaobaSkills"][number]>();
  for (const skill of state.xiaobaSkills) {
    if (
      skill.scope !== "base" &&
      (skill.scope !== "role" || skill.role_id !== state.exploreRole?.id)
    ) {
      continue;
    }
    const key = skill.id.toLowerCase();
    const current = byId.get(key);
    if (!current || skill.scope === "role") byId.set(key, skill);
  }
  const skills = [...byId.values()].sort(
    (left, right) =>
      left.display_name.localeCompare(right.display_name) ||
      left.id.localeCompare(right.id)
  );
  if (!query) return skills;
  return skills.filter((skill) =>
    [skill.id, skill.display_name, skill.description ?? ""].some((value) =>
      value.toLowerCase().includes(query)
    )
  );
}

function openCanvas(
  lines: string[],
  width: number,
  maxRows: number,
  color: boolean
): string {
  const inner = width - 4;
  const wrapped = lines.flatMap((line) => wrapText(line, inner));
  const visible = wrapped.slice(0, maxRows);
  if (wrapped.length > maxRows && visible.length > 0) {
    visible[visible.length - 1] = paint("… resize taller to see more", DIM, color);
  }
  return visible.map((line) => `  ${line}`).join("\n");
}

function exploreRunDashboard(
  state: EvaluationTuiState,
  width: number,
  color: boolean
): string[] {
  if (state.exploreDetails) {
    return exploreDetailedActivity(state, width, color);
  }
  const events = state.exploreProgress;
  const phase = explorePhase(events);
  const interactions = events.filter(
    (event) =>
      event.actor === "target" &&
      event.stage === "target" &&
      event.status === "completed"
  ).length;
  const signal = [...events]
    .reverse()
    .find(
      (event) =>
        event.status === "completed" &&
        (event.message ||
          (event.summary &&
            ["inspector", "reviewer"].includes(event.actor)))
    );
  const evidence = [...events]
    .reverse()
    .find((event) => event.evidence)?.evidence;
  const actors: Array<{
    actor: ExploreProgressEvent["actor"];
    label: string;
    waiting: string;
  }> = [
    {
      actor: "user_simulator",
      label: "UserCat",
      waiting: "preparing the first realistic user situation",
    },
    {
      actor: "target",
      label: state.exploreRole?.display_name ?? "Target Agent",
      waiting: "waiting for UserCat",
    },
    {
      actor: "inspector",
      label: "InspectorCat",
      waiting: "waiting for conversation and execution evidence",
    },
    {
      actor: "reviewer",
      label: "ReviewerCat",
      waiting: "waiting for InspectorCat findings",
    },
  ];
  return [
    `${heading("Evaluation running", color)}  ${
      state.exploreRole?.display_name ?? state.exploreRole?.id ?? "Target Agent"
    }`,
    ...(state.exploreSkill
      ? [paint(`Focus: ${state.exploreSkill.display_name} Skill`, DIM, color)]
      : [paint("Focus: complete Agent configuration", DIM, color)]),
    explorePhaseLine(phase, color),
    "",
    ...actors.map(({ actor, label, waiting }) =>
      actorActivityLine(events, actor, label, waiting, color)
    ),
    "",
    row(
      "Interactions",
      `${interactions} observed; Auto stops when evidence is sufficient`
    ),
    row(
      "Evidence",
      evidence
        ? [
            evidence.otlp_spans !== undefined
              ? `${evidence.otlp_spans} OTel spans`
              : undefined,
            evidence.workspace_changes !== undefined
              ? `${evidence.workspace_changes} workspace changes`
              : undefined,
          ]
            .filter(Boolean)
            .join(" · ")
        : "collecting conversation, Runtime, and workspace evidence"
    ),
    "",
    paint("Latest signal", `${BOLD}${GOLD}`, color),
    signal
      ? progressPreview(
          signal.message ?? signal.summary ?? "Evidence recorded.",
          Math.max(48, width * 2)
        )
      : "Waiting for the first observable interaction.",
    "",
    paint(
      "Press d for observable messages, findings, and evidence events.",
      DIM,
      color
    ),
  ];
}

function actorActivityLine(
  events: ExploreProgressEvent[],
  actor: ExploreProgressEvent["actor"],
  label: string,
  waiting: string,
  color: boolean
): string {
  const event = [...events].reverse().find((candidate) => candidate.actor === actor);
  if (!event) {
    return `${paint("○", DIM, color)} ${label.padEnd(18)} ${paint(
      waiting,
      DIM,
      color
    )}`;
  }
  const glyph =
    event.status === "started"
      ? "●"
      : event.status === "completed"
        ? "✓"
        : event.status === "blocked"
          ? "!"
          : "–";
  const activity =
    actor === "user_simulator"
      ? event.status === "started"
        ? `designing interaction ${event.turn ?? 1}`
        : event.message
          ? `sent interaction ${event.turn ?? 1}`
          : "test campaign complete"
      : actor === "target"
        ? event.status === "started"
          ? `responding to interaction ${event.turn ?? 1}`
          : `response ${event.turn ?? 1} recorded`
        : actor === "inspector"
          ? event.status === "started"
            ? "inspecting behavior, trace, and artifacts"
            : `${event.issue_count ?? 0} finding(s) recorded`
          : event.status === "started"
            ? "judging the outcome from collected evidence"
            : event.verdict
              ? `verdict ${event.verdict}`
              : "review complete";
  return `${paint(
    glyph,
    event.status === "blocked" ? GOLD : DEFAULT_FOREGROUND,
    color
  )} ${label.padEnd(18)} ${activity}`;
}

function exploreDetailedActivity(
  state: EvaluationTuiState,
  width: number,
  color: boolean
): string[] {
  const events = state.exploreProgress;
  const latestTurn = events.reduce(
    (maximum, event) => Math.max(maximum, event.turn ?? 0),
    0
  );
  const actors: Array<{
    actor: ExploreProgressEvent["actor"];
    label: string;
  }> = [
    { actor: "user_simulator", label: "UserCat" },
    { actor: "target", label: state.exploreRole?.id ?? "Target Agent" },
    { actor: "inspector", label: "InspectorCat" },
    { actor: "reviewer", label: "ReviewerCat" },
  ];
  const detailEvents = events
    .filter(
      (event) =>
        event.stage !== "probe" &&
        (event.message ||
          event.reason ||
          event.stage === "inspector" ||
          event.stage === "reviewer" ||
          event.stage === "evidence" ||
          event.stage === "complete" ||
          event.status === "blocked")
    )
    .slice(-3);
  return [
    `${heading("Execution details", color)}${
      latestTurn
        ? `  ${paint(`turn ${latestTurn}/${state.exploreMaxTurns}`, DIM, color)}`
        : ""
    }`,
    paint(
      "Observed actor events—not hidden model reasoning. Press d to return.",
      DIM,
      color
    ),
    "",
    ...actors.map(({ actor, label }) => {
      const latest = [...events].reverse().find((event) => event.actor === actor);
      const status = latest?.status ?? "waiting";
      const glyph =
        status === "started"
          ? "●"
          : status === "completed"
            ? "✓"
            : status === "blocked"
              ? "!"
              : status === "skipped"
                ? "–"
                : "○";
      const statusLabel =
        status === "started"
          ? "working"
          : status === "completed"
            ? "done"
            : status;
      return `${paint(glyph, status === "blocked" ? GOLD : DEFAULT_FOREGROUND, color)} ${label.padEnd(
        18
      )} ${statusLabel}`;
    }),
    "",
    paint("Activity", `${BOLD}${GOLD}`, color),
    ...(detailEvents.length
      ? detailEvents.flatMap((event) =>
          renderExploreProgressEvent(event, width, color)
        )
      : [
          paint(
            "Waiting for Runtime preflight and the first UserCat turn…",
            DIM,
            color
          ),
        ]),
  ];
}

type ExploreHumanPhase = "explore" | "inspect" | "judge";

function explorePhase(events: ExploreProgressEvent[]): ExploreHumanPhase {
  if (
    events.some(
      (event) =>
        event.stage === "reviewer" ||
        event.stage === "evidence" ||
        event.stage === "complete"
    )
  ) {
    return "judge";
  }
  if (events.some((event) => event.stage === "inspector")) {
    return "inspect";
  }
  return "explore";
}

function explorePhaseLine(
  active: ExploreHumanPhase,
  color: boolean
): string {
  const phases: Array<{ id: ExploreHumanPhase; label: string }> = [
    { id: "explore", label: "1 Explore" },
    { id: "inspect", label: "2 Inspect" },
    { id: "judge", label: "3 Judge" },
  ];
  const activeIndex = phases.findIndex((phase) => phase.id === active);
  return phases
    .map((phase, index) => {
      if (index < activeIndex) return paint(`✓ ${phase.label}`, DIM, color);
      if (index === activeIndex) {
        return paint(`[${phase.label}]`, `${BOLD}${GOLD}`, color);
      }
      return paint(phase.label, DIM, color);
    })
    .join("  ──  ");
}

function exploreCurrentActivity(
  event: ExploreProgressEvent | undefined
): string {
  if (!event || event.stage === "probe") return "Checking the local Runtime";
  if (event.actor === "user_simulator") {
    return event.status === "started"
      ? "Simulated user is choosing the next realistic turn"
      : "A new user interaction is ready";
  }
  if (event.actor === "target") {
    return event.status === "started"
      ? "Target Agent is responding"
      : "Target response recorded";
  }
  if (event.actor === "inspector") {
    return event.status === "started"
      ? "Analyzing behavior and execution evidence"
      : "Evidence analysis complete";
  }
  if (event.actor === "reviewer") {
    return event.status === "started"
      ? "Reviewing the target outcome"
      : "Outcome review complete";
  }
  return event.stage === "evidence"
    ? "Checking evidence completeness"
    : "Finalizing the evaluation";
}

function exploreActivityExplanation(
  event: ExploreProgressEvent | undefined
): string {
  if (!event) return "Barena is preparing an evidence-backed Explore run.";
  if (event.turn && event.actor === "target") {
    return `Interaction ${event.turn}; the conversation is visible after completion.`;
  }
  if (event.turn && event.actor === "user_simulator") {
    return `Interaction ${event.turn}; Barena stops automatically when another turn adds no value.`;
  }
  return event.summary ?? "Barena is preserving observable evidence.";
}

function renderExploreProgressEvent(
  event: ExploreProgressEvent,
  width: number,
  color: boolean
): string[] {
  const label =
    event.actor === "user_simulator"
      ? "UserCat"
      : event.actor === "target"
        ? "Target"
        : event.actor === "inspector"
          ? "InspectorCat"
          : event.actor === "reviewer"
            ? "ReviewerCat"
            : "Barena";
  const meta = [
    `#${event.sequence}`,
    label,
    event.turn ? `turn ${event.turn}` : undefined,
    event.status,
    event.verdict ? `verdict ${event.verdict}` : undefined,
    event.issue_count !== undefined ? `${event.issue_count} issue(s)` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const limit = Math.max(36, Math.floor(width * 1.25));
  const lines = [paint(meta, GOLD, color)];
  if (event.message) {
    lines.push(
      `  ${event.actor === "user_simulator" ? "User" : "Response"}: “${progressPreview(
        event.message,
        limit
      )}”`
    );
  }
  if (event.reason) {
    lines.push(`  Reason: ${progressPreview(event.reason, limit)}`);
  }
  if (
    event.summary &&
    (!event.message ||
      event.actor === "inspector" ||
      event.actor === "reviewer" ||
      event.actor === "barena")
  ) {
    lines.push(`  ${progressPreview(event.summary, limit)}`);
  }
  if (event.evidence) {
    const evidence = [
      event.evidence.otlp_spans !== undefined
        ? `${event.evidence.otlp_spans} OTLP spans`
        : undefined,
      event.evidence.workspace_changes !== undefined
        ? `${event.evidence.workspace_changes} workspace changes`
        : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    if (evidence) lines.push(`  Evidence: ${evidence}`);
  }
  return lines;
}

function progressPreview(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, Math.max(1, limit - 1))}…`;
}

function exploreTranscriptBody(
  state: EvaluationTuiState,
  width: number,
  height: number,
  color: boolean
): string[] {
  const result = state.exploreResult!;
  const messages = result.transcript;
  const start = Math.min(
    state.exploreTranscriptOffset,
    Math.max(0, messages.length - 1)
  );
  const availableRows = Math.max(5, height - 4);
  const lines: string[] = [];
  let visible = 0;
  for (const message of messages.slice(start)) {
    const label =
      message.actor === "user_simulator"
        ? `Simulated user · interaction ${message.turn}`
        : `${result.scenario.target.role} · interaction ${message.turn}`;
    const block = [
      paint(label, `${BOLD}${GOLD}`, color),
      ...wrapText(
        progressPreview(message.content, Math.max(120, width * 3)),
        Math.max(20, width - 4)
      ).map((line) => `  ${line}`),
      "",
    ];
    if (lines.length && lines.length + block.length > availableRows) break;
    lines.push(...block);
    visible += 1;
  }
  return [
    heading(
      `Conversation  ${start + 1}-${start + visible}/${messages.length}`,
      color
    ),
    paint(result.scenario.objective, DIM, color),
    "",
    ...lines,
  ];
}

function menu(items: string[], selected: number, color: boolean): string[] {
  return items.map((item, index) =>
    menuLine(item, index, index === selected, color)
  );
}

function menuWindow(
  items: string[],
  selected: number,
  size: number,
  color: boolean
): string[] {
  if (items.length <= size) return menu(items, selected, color);
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(size / 2), items.length - size)
  );
  const visible = items.slice(start, start + size);
  return visible.map((item, offset) => {
    const index = start + offset;
    const scroll =
      offset === 0 && start > 0
        ? "up"
        : offset === visible.length - 1 && start + size < items.length
          ? "down"
          : undefined;
    return menuLine(item, index, index === selected, color, scroll);
  });
}

function menuLine(
  item: string,
  index: number,
  selected: boolean,
  color: boolean,
  scroll?: "up" | "down"
): string {
  const marker = selected
    ? selectionMarker(true, color)
    : scroll
      ? ` ${paint(scroll === "up" ? "↑" : "↓", GOLD, color)} `
      : selectionMarker(false, color);
  const content = `${index + 1}. ${item}`;
  return `${marker} ${selected ? paint(content, BOLD, color) : content}`;
}

function selectionMarker(selected: boolean, color: boolean): string {
  if (!selected) return "   ";
  return color ? paint(" ▸ ", SELECTED_MARKER, true) : " > ";
}

function heading(value: string, color: boolean): string { return paint(value, BOLD, color); }
function row(label: string, value: string): string { return `${label.padEnd(13)} ${value}`; }
function decision(value: string, color: boolean): string { return paint(value.toUpperCase(), value === "cleared" ? "\x1b[38;5;82m" : value === "rejected" ? "\x1b[38;5;196m" : GOLD, color); }
function exploreOutcome(value: string, color: boolean): string {
  if (value === "pass") {
    return paint("PASSED", "\x1b[38;5;82m", color);
  }
  if (value === "fail") {
    return paint("NEEDS IMPROVEMENT", `${BOLD}${GOLD}`, color);
  }
  if (value === "unsafe") {
    return paint("UNSAFE", "\x1b[38;5;196m", color);
  }
  return paint("COULD NOT VERIFY", GOLD, color);
}
function renderExploreFinding(
  issue: { summary: string; evidence: string[] },
  index: number
): string {
  const evidence = issue.evidence[0] ? `  [${issue.evidence[0]}]` : "";
  return `${index + 1}. ${issue.summary}${evidence}`;
}

function exploreCasesBody(
  state: EvaluationTuiState,
  width: number,
  height: number,
  color: boolean
): string[] {
  const candidates = state.exploreResult?.replay_case_candidates ?? [];
  const candidate = candidates[state.selected];
  if (!candidate) {
    return [heading("Replay Cases", color), "", "No Case candidate was generated."];
  }
  const contentWidth = Math.max(24, width - 2);
  const lines = [
    `${heading("Replay Case candidate", color)}  ${paint(`${state.selected + 1}/${candidates.length}`, DIM, color)}`,
    "",
    row("Finding", candidate.issue_summary),
    row("Evidence", candidate.evidence.join(", ") || "not recorded"),
    "",
    paint("Reproduction prompt", `${BOLD}${GOLD}`, color),
    ...wrapText(candidate.prompt, contentWidth),
    "",
    paint(
      "Proposed from this Explore run. Review it, then promote it into Replay to protect the behavior.",
      DIM,
      color
    ),
  ];
  return lines.slice(0, Math.max(3, height));
}

function footer(
  state: EvaluationTuiState,
  color: boolean,
  width: number
): string {
  const value = state.screen === "home"
    ? state.homeMode === "product"
      ? width < 64
        ? "↑/↓ choose · Enter · q"
        : "↑/↓ choose · Enter select · d DAG · p runs · ? setup · q quit"
      : "↑/↓ choose · Enter select · q quit"
    : state.screen === "skill_home"
      ? "↑/↓ choose · Enter select · Esc product home · q quit"
      : state.screen === "explore_runtime" || state.screen === "explore_role"
        ? "↑/↓ choose · Enter select · Esc back · q quit"
        : state.screen === "explore_task"
          ? "Type objective · /agent or /skill optional · Enter review · ^U clear · Esc back"
          : state.screen === "explore_skill"
            ? "Type to filter · ↑/↓ choose · Enter bind · Esc composer"
          : state.screen === "explore_review"
            ? "Enter run · e/Esc edit · model calls may incur cost"
            : state.screen === "explore_confirm"
              ? "y start · n/Esc cancel"
              : state.screen === "explore_running"
                ? "d execution details · Ctrl+C cancel safely · keep this terminal open"
              : state.screen === "explore_result"
                ? "c Replay Cases · v conversation · e edit intent · h home · q quit"
              : state.screen === "explore_cases"
                ? "↑/↓ Cases · b result · q quit"
              : state.screen === "explore_transcript"
                ? "↑/↓ conversation · b result · q quit"
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
function pad(value: string, width: number): string { return value + " ".repeat(Math.max(0, width - displayWidth(value))); }
function center(value: string, width: number): string {
  const length = displayWidth(value);
  return length >= width ? stripAnsi(value).slice(0, width) : `${" ".repeat(Math.floor((width - length) / 2))}${value}`;
}

function wrapText(value: string, width: number): string[] {
  if (displayWidth(value) <= width) return [value];
  const plain = stripAnsi(value);
  const lines: string[] = [];
  let remaining = Array.from(plain);
  while (remaining.length) {
    let cells = 0;
    let end = 0;
    let lastSpace = -1;
    while (end < remaining.length) {
      const next = characterWidth(remaining[end]);
      if (cells + next > width) break;
      cells += next;
      if (/\s/u.test(remaining[end])) lastSpace = end;
      end += 1;
    }
    if (end === remaining.length) {
      lines.push(remaining.join("").trimEnd());
      break;
    }
    const split =
      lastSpace >= Math.floor(end / 2)
        ? lastSpace
        : Math.max(1, end);
    lines.push(remaining.slice(0, split).join("").trimEnd());
    remaining = remaining.slice(
      lastSpace >= Math.floor(end / 2) ? split + 1 : split
    );
    while (remaining[0] && /\s/u.test(remaining[0])) remaining.shift();
  }
  return lines;
}

function displayWidth(value: string): number {
  return Array.from(stripAnsi(value)).reduce(
    (sum, character) => sum + characterWidth(character),
    0
  );
}

function characterWidth(character: string): number {
  if (/[\p{Mark}\u0000-\u001f\u007f]/u.test(character)) return 0;
  const point = character.codePointAt(0) ?? 0;
  return point >= 0x1100 &&
    (point <= 0x115f ||
      point === 0x2329 ||
      point === 0x232a ||
      (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f) ||
      (point >= 0xac00 && point <= 0xd7a3) ||
      (point >= 0xf900 && point <= 0xfaff) ||
      (point >= 0xfe10 && point <= 0xfe19) ||
      (point >= 0xfe30 && point <= 0xfe6f) ||
      (point >= 0xff00 && point <= 0xff60) ||
      (point >= 0xffe0 && point <= 0xffe6) ||
      (point >= 0x1f300 && point <= 0x1faff) ||
      (point >= 0x20000 && point <= 0x3fffd))
    ? 2
    : 1;
}

function resultCandidateName(result: AnyEvaluationResult): string {
  if (result.schema === "barena.skill_evaluation.v1") {
    return result.candidate.selection.mode === "path" ? result.candidate.selection.name : "candidate";
  }
  return result.candidate.selection.mode === "role_skill"
    ? result.candidate.selection.skill.name
    : result.candidate.selection.role.role_id;
}
