import figlet from "figlet";
import { Scorecard, SubjectManifest } from "../domain/types";
import { TuiRunSummary, TuiState } from "./state";

type HeroFont = "ANSI Shadow";

export type TuiView = "overview" | "subjects" | "runs" | "commands";

export interface TuiRenderOptions {
  view?: TuiView;
  selectedIndex?: number;
  width?: number;
  color?: boolean;
}

const VIEWS: TuiView[] = ["overview", "subjects", "runs", "commands"];
const DEFAULT_WIDTH = 120;
const MIN_WIDTH = 72;

export function nextView(view: TuiView, direction: 1 | -1): TuiView {
  const index = VIEWS.indexOf(view);
  return VIEWS[(index + direction + VIEWS.length) % VIEWS.length];
}

export function renderTui(state: TuiState, options: TuiRenderOptions = {}): string {
  const width = Math.max(MIN_WIDTH, options.width ?? process.stdout.columns ?? DEFAULT_WIDTH);
  const color = options.color ?? true;
  const view = options.view ?? "overview";
  const selectedIndex = options.selectedIndex ?? 0;
  const lines: string[] = [];

  lines.push(header(width, color));
  lines.push(nav(view, width, color));
  lines.push("");

  if (view === "overview") {
    lines.push(...overview(state, width, color));
  } else if (view === "subjects") {
    lines.push(...subjectsView(state.subjects, selectedIndex, width, color));
  } else if (view === "runs") {
    lines.push(...runsView(state.runs, selectedIndex, width, color));
  } else {
    lines.push(...commandsView(width, color));
  }

  lines.push("");
  lines.push(dim("left/right: view  up/down: select  r: refresh  q: quit", color));
  return lines.join("\n");
}

function header(width: number, color: boolean): string {
  const rows: string[] = [];

  rows.push("");
  rows.push(topRule(width, color));
  rows.push("");

  rows.push(topCopyGold(center("AGENTS CAN GROW.", width), color));
  rows.push("");
  rows.push(...paintBlock(figletLines("BARENA", "ANSI Shadow"), width, gold, color));
  rows.push("");
  rows.push(warmGold(center("MAKES GROWTH REVIEWABLE.", width), color));

  rows.push("");
  rows.push(footerGold(center("trace / replay / arena / scorecard", width), color));
  rows.push("");
  return rows.map((line) => pad(line, width)).join("\n");
}

function nav(view: TuiView, width: number, color: boolean): string {
  const label = VIEWS.map((item) => (item === view ? accent(`[${item.toUpperCase()}]`, color) : item)).join("  ");
  return fit(` ${label}`, width);
}

function overview(state: TuiState, width: number, color: boolean): string[] {
  const latest = state.runs.find((run) => run.scorecard);
  const flow = [
    step("1", "IMPORT", "skill / github", color),
    step("2", "SCAN", "static gate", color),
    step("3", "USERCAT", "low-info use", color),
    step("4", "TRACE", "logs + artifact", color),
    step("5", "INSPECT", "issues", color),
    step("6", "REPLAY", "stability", color),
    step("7", "DECIDE", "clear / hold", color),
  ].join(dim(" -> ", color));

  const left = [
    strong("Clearance Lane", color),
    flow,
    "",
    metric("Subjects", String(state.subjects.length), color),
    metric("Runs", String(state.runs.length), color),
    metric("Latest", latest?.scorecard ? summarizeScorecard(latest.scorecard) : "no scorecard yet", color),
  ];
  const right = [
    strong("Why Trust", color),
    badge("clean runtime", "no production pollution", color),
    badge("evidence refs", "trace + artifact paths", color),
    badge("not one pass", "replay attempts recorded", color),
    badge("verifier hook", "external check optional", color),
  ];
  return twoColumns(left, right, width, color);
}

function subjectsView(subjects: SubjectManifest[], selectedIndex: number, width: number, color: boolean): string[] {
  if (subjects.length === 0) {
    return box(["No subjects yet.", "Run: barena import skill <path>"], width, color).split("\n");
  }
  const rows = subjects.map((subject, index) => {
    const selected = index === clamp(selectedIndex, subjects.length);
    const scan = String(subject.metadata.scan_decision ?? "unknown");
    return row(
      selected,
      [
        subject.subject_id,
        subject.type,
        scan,
        subject.source.kind,
        subject.imported_at.slice(0, 19),
      ],
      [24, 10, 15, 10, 22],
      color
    );
  });
  return box([strong("Subjects", color), headerRow(["id", "type", "scan", "source", "imported"], [24, 10, 15, 10, 22]), ...rows], width, color).split("\n");
}

function runsView(runs: TuiRunSummary[], selectedIndex: number, width: number, color: boolean): string[] {
  if (runs.length === 0) {
    return box(["No runs yet.", "Run: barena run <subject-id>"], width, color).split("\n");
  }
  const rows = runs.map((run, index) => {
    const selected = index === clamp(selectedIndex, runs.length);
    const scorecard = run.scorecard;
    return row(
      selected,
      [
        run.run_id,
        run.subject_id ?? "-",
        scorecard ? scorecard.decision : "pending",
        scorecard ? scorecard.status : "no-score",
        run.created_at ? run.created_at.slice(0, 19) : "-",
      ],
      [28, 20, 12, 12, 22],
      color
    );
  });
  const selected = runs[clamp(selectedIndex, runs.length)];
  const detail = selected?.scorecard
    ? ["", strong("Selected Scorecard", color), ...scorecardDetail(selected.scorecard, color)]
    : [];
  return box([strong("Runs", color), headerRow(["run", "subject", "decision", "status", "created"], [28, 20, 12, 12, 22]), ...rows, ...detail], width, color).split("\n");
}

function commandsView(width: number, color: boolean): string[] {
  return box(
    [
      strong("Release Commands", color),
      "barena import skill <path> --id <subject>",
      "barena import github <owner/repo> --id <subject> --ref <ref>",
      "barena scan <subject>",
      "barena run <subject> --replays 3 --verifier <path>",
      "barena scorecard <run-id>",
      "barena report <run-id> --format markdown",
      "",
      strong("Runtime stance", color),
      "provider: barena-deterministic",
      "adapter: xiaoba-compatible",
      "xiaoba_invoked: false",
    ],
    width,
    color
  ).split("\n");
}

function scorecardDetail(scorecard: Scorecard, color: boolean): string[] {
  return [
    metric("Decision", scorecard.decision, color),
    metric("Status", scorecard.status, color),
    metric("Replay", `${scorecard.replay_attempts.pass_count}/${scorecard.replay_attempts.completed} pass`, color),
    metric("Issues", String(scorecard.issues.length), color),
  ];
}

function step(number: string, name: string, caption: string, color: boolean): string {
  return `${accent(number, color)} ${strong(name, color)} ${dim(caption, color)}`;
}

function metric(label: string, value: string, color: boolean): string {
  return `${dim(label.padEnd(12), color)} ${value}`;
}

function badge(label: string, value: string, color: boolean): string {
  return `${accent(label.padEnd(14), color)} ${value}`;
}

function summarizeScorecard(scorecard: Scorecard): string {
  return `${scorecard.subject_id} / ${scorecard.decision} / ${scorecard.status}`;
}

function twoColumns(left: string[], right: string[], width: number, color: boolean): string[] {
  const gap = 3;
  const columnWidth = Math.floor((width - gap - 4) / 2);
  const maxRows = Math.max(left.length, right.length);
  const rows: string[] = [];
  for (let index = 0; index < maxRows; index += 1) {
    rows.push(`${pad(left[index] ?? "", columnWidth)}${" ".repeat(gap)}${pad(right[index] ?? "", columnWidth)}`);
  }
  return box(rows, width, color).split("\n");
}

function row(selected: boolean, values: string[], widths: number[], color: boolean): string {
  const content = values.map((value, index) => fit(value, widths[index])).join("  ");
  return selected ? accent(`> ${content}`, color) : `  ${content}`;
}

function headerRow(values: string[], widths: number[]): string {
  return `  ${values.map((value, index) => fit(value.toUpperCase(), widths[index])).join("  ")}`;
}

function box(content: string[], width: number, color: boolean): string {
  const inner = width - 4;
  const top = `+${"-".repeat(inner + 2)}+`;
  const rows = content.map((line) => `| ${pad(line, inner)} |`);
  const body = [top, ...rows, top].join("\n");
  return color ? teal(body) : body;
}

function figletLines(value: string, font: HeroFont): string[] {
  return figlet
    .textSync(value, {
      font,
      horizontalLayout: "default",
      verticalLayout: "default",
    })
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

function paintBlock(lines: string[], width: number, paint: (value: string, color: boolean) => string, color: boolean): string[] {
  const blockWidth = Math.max(0, ...lines.map((line) => stripAnsi(line).length));
  return lines.map((line) => paint(center(pad(line, blockWidth), width), color));
}

function center(value: string, width: number): string {
  const plain = stripAnsi(value);
  if (plain.length >= width) {
    return fit(value, width);
  }
  const left = Math.floor((width - plain.length) / 2);
  return `${" ".repeat(left)}${value}`;
}

function topRule(width: number, color: boolean): string {
  const ruleWidth = Math.max(18, Math.round(width * 0.815));
  const left = Math.max(0, Math.round(width * 0.092));
  return `${" ".repeat(left)}${darkGold("─".repeat(Math.min(ruleWidth, width - left)), color)}`;
}

function fit(value: string, width: number): string {
  const plain = stripAnsi(value);
  if (plain.length > width) {
    return `${plain.slice(0, Math.max(0, width - 1))}~`;
  }
  return value + " ".repeat(width - plain.length);
}

function pad(value: string, width: number): string {
  const plain = stripAnsi(value);
  if (plain.length > width) {
    return fit(value, width);
  }
  return value + " ".repeat(width - plain.length);
}

function clamp(index: number, length: number): number {
  return Math.max(0, Math.min(index, Math.max(0, length - 1)));
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function strong(value: string, color: boolean): string {
  return color ? `\x1b[1m${value}\x1b[22m` : value;
}

function accent(value: string, color: boolean): string {
  return color ? `\x1b[38;5;220m${value}\x1b[39m` : value;
}

function gold(value: string, color: boolean): string {
  return color ? `\x1b[38;5;220m${value}\x1b[39m` : value;
}

function visibleCream(value: string, color: boolean): string {
  return color ? `\x1b[38;5;230m${value}\x1b[39m` : value;
}

function topCopyGold(value: string, color: boolean): string {
  return color ? `\x1b[38;5;136m${value}\x1b[39m` : value;
}

function warmGold(value: string, color: boolean): string {
  return color ? `\x1b[38;5;222m${value}\x1b[39m` : value;
}

function footerGold(value: string, color: boolean): string {
  return color ? `\x1b[38;5;222m${value}\x1b[39m` : value;
}

function darkGold(value: string, color: boolean): string {
  return color ? `\x1b[38;5;94m${value}\x1b[39m` : value;
}

function dim(value: string, color: boolean): string {
  return color ? `\x1b[2m${value}\x1b[22m` : value;
}

function teal(value: string): string {
  return `\x1b[38;5;30m${value}\x1b[39m`;
}
