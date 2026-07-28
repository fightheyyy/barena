import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const reportPath = path.resolve(here, "../results/latest.json");
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));

const expected = {
  rollouts: 144,
  rawScored: 127,
  admitted: 90,
  excluded: 54,
  invalidated: 37,
  rawUnscored: 17,
  completeTasks: 9,
  matchedPairs: 36,
  matchedRollouts: 72,
  matchedTasks: 14,
  pairedBaselinePassed: 14,
  pairedCandidatePassed: 20,
  pairedLift: 0.16666666666666669,
  candidateOnly: 8,
  baselineOnly: 2,
  mcnemar: 0.109375,
  cleared: 2,
  held: 7,
  rejected: 0,
  incomplete: 15,
  noEffect: 4,
  unstable: 3,
};

function assertExact(actual, expectedValue, label) {
  if (actual !== expectedValue) {
    throw new Error(`${label}: expected ${expectedValue}, got ${actual}`);
  }
}

assertExact(report.plan.planned_rollouts, expected.rollouts, "planned rollouts");
assertExact(report.evidence.raw_scored_result_count, expected.rawScored, "raw numeric rewards");
assertExact(report.evidence.scored_result_count, expected.admitted, "admitted scores");
assertExact(report.evidence.unscored_result_count, expected.excluded, "excluded scores");
assertExact(report.evidence.invalidated_result_count, expected.invalidated, "invalidated rewards");
assertExact(report.evidence.raw_unscored_result_count, expected.rawUnscored, "raw unscored");
assertExact(report.evidence.complete_task_count, expected.completeTasks, "complete tasks");
assertExact(report.aggregate.paired_trials.pair_count, expected.matchedPairs, "matched pairs");
assertExact(report.aggregate.paired_trials.rollout_count, expected.matchedRollouts, "matched rollouts");
assertExact(report.aggregate.paired_trials.task_count, expected.matchedTasks, "matched tasks");
assertExact(report.aggregate.paired_trials.baseline.passed, expected.pairedBaselinePassed, "paired baseline passes");
assertExact(report.aggregate.paired_trials.candidate.passed, expected.pairedCandidatePassed, "paired candidate passes");
assertExact(report.aggregate.paired_trials.observed_lift, expected.pairedLift, "paired lift");
assertExact(report.aggregate.paired_trials.transitions.candidate_only, expected.candidateOnly, "candidate-only passes");
assertExact(report.aggregate.paired_trials.transitions.baseline_only, expected.baselineOnly, "baseline-only passes");
assertExact(report.aggregate.paired_trials.mcnemar_exact_p_value, expected.mcnemar, "McNemar p");
assertExact(report.aggregate.complete_tasks.decisions.cleared, expected.cleared, "cleared");
assertExact(report.aggregate.complete_tasks.decisions.held, expected.held, "held");
assertExact(report.aggregate.complete_tasks.decisions.rejected, expected.rejected, "rejected");
assertExact(report.aggregate.decision_reasons.evidence_incomplete, expected.incomplete, "incomplete");
assertExact(report.aggregate.complete_tasks.decision_reasons.no_effect, expected.noEffect, "no effect");
assertExact(report.aggregate.complete_tasks.decision_reasons.unstable_result, expected.unstable, "unstable");

const clearedTasks = report.tasks.filter((task) => task.decision === "cleared");
const taskLabels = {
  "bike-rebalance": "Bike Rebalance",
  "llm-prefix-cache-replay": "LLM Prefix Cache Replay",
};

const themes = [
  {
    id: "black-gold",
    title: "BLACK GOLD / AUDITED EVIDENCE",
    bg: "#080806",
    panel: "#11110F",
    panel2: "#171610",
    ink: "#F8F2E4",
    muted: "#A7A092",
    accent: "#E8B64B",
    accent2: "#F3D58A",
    positive: "#69D5A5",
    negative: "#FF7667",
    stroke: "#302D24",
    grid: "#1B1914",
  },
  {
    id: "paper-white",
    title: "PAPER WHITE / AUDITED EVIDENCE",
    bg: "#F3EFE6",
    panel: "#FFFDF7",
    panel2: "#EBE5D9",
    ink: "#1A1B19",
    muted: "#67645D",
    accent: "#B64632",
    accent2: "#D78468",
    positive: "#007E72",
    negative: "#C6473F",
    stroke: "#D4CCBE",
    grid: "#E7E0D4",
  },
  {
    id: "midnight-blue",
    title: "MIDNIGHT BLUE / AUDITED EVIDENCE",
    bg: "#07111F",
    panel: "#0D1B2D",
    panel2: "#11243A",
    ink: "#EDF4FF",
    muted: "#91A5C0",
    accent: "#58C8F2",
    accent2: "#A3E6FF",
    positive: "#42D6A1",
    negative: "#FF7A72",
    stroke: "#233A57",
    grid: "#102139",
  },
];

const width = 1600;
const height = 2200;

const esc = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function text(x, y, value, options = {}) {
  const {
    size = 28,
    fill = "currentColor",
    weight = 500,
    anchor = "start",
    letterSpacing = 0,
    family = "Arial, PingFang SC, Hiragino Sans GB, sans-serif",
    opacity = 1,
  } = options;
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="${family}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" letter-spacing="${letterSpacing}" opacity="${opacity}">${esc(value)}</text>`;
}

function rect(x, y, w, h, options = {}) {
  const {
    fill = "none",
    stroke = "none",
    strokeWidth = 1,
    radius = 24,
    opacity = 1,
  } = options;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"/>`;
}

function line(x1, y1, x2, y2, options = {}) {
  const { stroke = "currentColor", strokeWidth = 2, opacity = 1, dash = "" } = options;
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function pp(value) {
  const amount = value * 100;
  return `${amount > 0 ? "+" : ""}${amount.toFixed(1)} pp`;
}

function decorate(theme) {
  if (theme.id === "black-gold") {
    return [
      `<path d="M0 305 L1600 42" stroke="${theme.accent}" stroke-width="2" opacity=".18"/>`,
      `<path d="M930 0 L1600 116" stroke="${theme.accent}" stroke-width="26" opacity=".08"/>`,
      `<circle cx="1450" cy="160" r="96" fill="none" stroke="${theme.accent}" stroke-width="2" opacity=".32"/>`,
      `<circle cx="1450" cy="160" r="54" fill="none" stroke="${theme.accent}" stroke-width="2" opacity=".16"/>`,
    ].join("");
  }
  if (theme.id === "paper-white") {
    return [
      rect(0, 0, 24, height, { fill: theme.accent, radius: 0 }),
      ...Array.from({ length: 13 }, (_, index) =>
        line(100 + index * 120, 0, 100 + index * 120, height, {
          stroke: theme.grid,
          strokeWidth: 1,
          opacity: 0.45,
        }),
      ),
      `<path d="M1160 0 H1600 V250 Z" fill="${theme.accent}" opacity=".08"/>`,
    ].join("");
  }
  return [
    `<defs><radialGradient id="glow" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="${theme.accent}" stop-opacity=".22"/><stop offset="100%" stop-color="${theme.accent}" stop-opacity="0"/></radialGradient></defs>`,
    `<circle cx="1390" cy="160" r="230" fill="url(#glow)"/>`,
    `<path d="M1100 60 L1220 210 L1340 60 L1460 210" fill="none" stroke="${theme.accent}" stroke-width="2" opacity=".2"/>`,
  ].join("");
}

function panelTitle(theme, x, y, label, index) {
  return [
    text(x, y, String(index).padStart(2, "0"), {
      size: 20,
      fill: theme.accent,
      weight: 800,
      letterSpacing: 2,
    }),
    text(x + 52, y, label, {
      size: 20,
      fill: theme.muted,
      weight: 800,
      letterSpacing: 2.4,
    }),
  ].join("");
}

function horizontalBar(theme, x, y, w, value, fill) {
  return [
    rect(x, y, w, 24, { fill: theme.panel2, radius: 12 }),
    rect(x, y, w * value, 24, { fill, radius: 12 }),
  ].join("");
}

function step(theme, x, y, w, label, value, color = theme.ink) {
  return [
    rect(x, y, w, 86, {
      fill: theme.panel2,
      stroke: theme.stroke,
      strokeWidth: 1,
      radius: 16,
    }),
    text(x + 18, y + 31, label, {
      size: 14,
      fill: theme.muted,
      weight: 800,
      letterSpacing: 1.2,
    }),
    text(x + 18, y + 67, value, {
      size: 28,
      fill: color,
      weight: 900,
    }),
  ].join("");
}

function createPoster(theme) {
  const paired = report.aggregate.paired_trials;
  const baseline = paired.baseline;
  const candidate = paired.candidate;
  const complete = report.aggregate.complete_tasks;
  const decisions = complete.decisions;
  const reasons = complete.decision_reasons;
  const matchedFraction = paired.rollout_count / report.plan.planned_rollouts;
  const out = [];

  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  out.push(rect(0, 0, width, height, { fill: theme.bg, radius: 0 }));
  out.push(decorate(theme));

  // Header
  out.push(text(110, 96, "PUBLIC VALIDATION · AUDITED JUL 2026", {
    size: 22,
    fill: theme.accent,
    weight: 800,
    letterSpacing: 4,
  }));
  out.push(text(110, 205, "BARENA", {
    size: 112,
    fill: theme.ink,
    weight: 900,
    letterSpacing: -3,
  }));
  out.push(text(110, 282, "× SKILLSBENCH 1.1", {
    size: 62,
    fill: theme.accent,
    weight: 800,
    letterSpacing: 1,
  }));
  out.push(text(1490, 82, theme.title, {
    size: 17,
    fill: theme.muted,
    weight: 700,
    anchor: "end",
    letterSpacing: 2,
  }));
  out.push(text(1490, 248, "EVIDENCE FIRST.", {
    size: 32,
    fill: theme.ink,
    weight: 850,
    anchor: "end",
  }));
  out.push(text(1490, 292, "LIFT ONLY WHEN COMPARABLE.", {
    size: 30,
    fill: theme.accent,
    weight: 850,
    anchor: "end",
  }));
  out.push(text(1490, 330, "先验证证据，再讨论能力提升。", {
    size: 20,
    fill: theme.muted,
    weight: 550,
    anchor: "end",
  }));
  out.push(line(110, 370, 1490, 370, { stroke: theme.stroke, strokeWidth: 2 }));

  // Matched-pair hero
  out.push(rect(110, 415, 550, 350, {
    fill: theme.panel,
    stroke: theme.stroke,
    strokeWidth: 2,
    radius: 28,
  }));
  out.push(panelTitle(theme, 145, 460, "MATCHED TRIAL PAIRS", 1));
  out.push(text(145, 598, "36 PAIRS", {
    size: 104,
    fill: theme.positive,
    weight: 900,
    letterSpacing: -3,
  }));
  out.push(text(145, 650, "SAME TASK · SAME TRIAL · BOTH VERIFIED", {
    size: 18,
    fill: theme.ink,
    weight: 800,
    letterSpacing: 1.2,
  }));
  out.push(horizontalBar(theme, 145, 682, 470, matchedFraction, theme.positive));
  out.push(text(145, 736, "72 matched rollouts across 14 tasks", {
    size: 18,
    fill: theme.muted,
    weight: 650,
  }));

  // Gate
  out.push(rect(690, 415, 800, 350, {
    fill: theme.panel,
    stroke: theme.stroke,
    strokeWidth: 2,
    radius: 28,
  }));
  out.push(panelTitle(theme, 725, 460, "COMPLETE-TASK RELEASE GATE", 2));
  const gateColumns = [
    [725, decisions.cleared, "CLEARED", theme.positive],
    [925, decisions.held, "HELD", theme.accent],
    [1165, decisions.rejected, "REJECTED", theme.negative],
  ];
  for (const [x, value, label, color] of gateColumns) {
    out.push(text(x, 585, value, { size: 88, fill: color, weight: 900 }));
    out.push(text(x, 628, label, {
      size: 17,
      fill: color,
      weight: 850,
      letterSpacing: 2,
    }));
  }
  out.push(rect(725, 672, 720, 58, { fill: theme.panel2, radius: 14 }));
  out.push(text(745, 708, `${complete.task_count} complete tasks  ·  HELD = ${reasons.no_effect} no effect  ·  ${reasons.unstable_result} unstable`, {
    size: 20,
    fill: theme.ink,
    weight: 700,
  }));

  // Matched-pair arm results
  out.push(rect(110, 805, 950, 710, {
    fill: theme.panel,
    stroke: theme.stroke,
    strokeWidth: 2,
    radius: 28,
  }));
  out.push(panelTitle(theme, 145, 850, "MATCHED-PAIR RESULT", 3));
  out.push(text(1018, 850, `${paired.pair_count} EQUAL-DENOMINATOR PAIRS`, {
    size: 15,
    fill: theme.accent,
    weight: 850,
    anchor: "end",
    letterSpacing: 1.4,
  }));

  out.push(text(145, 948, "BASELINE · NO SKILL", {
    size: 18,
    fill: theme.muted,
    weight: 800,
    letterSpacing: 1.7,
  }));
  out.push(text(145, 1035, pct(baseline.value), {
    size: 82,
    fill: theme.ink,
    weight: 900,
  }));
  out.push(text(410, 1015, `${baseline.passed} passes / ${baseline.scored} matched`, {
    size: 24,
    fill: theme.ink,
    weight: 720,
  }));
  out.push(text(410, 1050, "paired against the same task + trial", {
    size: 18,
    fill: theme.muted,
    weight: 600,
  }));
  out.push(horizontalBar(theme, 145, 1082, 850, baseline.value, theme.muted));

  out.push(text(145, 1165, "CANDIDATE · WITH SKILL", {
    size: 18,
    fill: theme.muted,
    weight: 800,
    letterSpacing: 1.7,
  }));
  out.push(text(145, 1252, pct(candidate.value), {
    size: 82,
    fill: theme.positive,
    weight: 900,
  }));
  out.push(text(410, 1232, `${candidate.passed} passes / ${candidate.scored} matched`, {
    size: 24,
    fill: theme.ink,
    weight: 720,
  }));
  out.push(text(410, 1267, "paired against the same task + trial", {
    size: 18,
    fill: theme.muted,
    weight: 600,
  }));
  out.push(horizontalBar(theme, 145, 1299, 850, candidate.value, theme.positive));

  out.push(rect(145, 1360, 850, 112, {
    fill: theme.panel2,
    stroke: theme.accent,
    strokeWidth: 2,
    radius: 18,
  }));
  out.push(text(170, 1404, `OBSERVED PAIRED DIFFERENCE  ${pp(paired.observed_lift)}`, {
    size: 25,
    fill: theme.accent,
    weight: 900,
    letterSpacing: 1,
  }));
  out.push(text(170, 1442, `candidate-only ${paired.transitions.candidate_only} · baseline-only ${paired.transitions.baseline_only} · exact McNemar p = ${paired.mcnemar_exact_p_value.toFixed(3)}`, {
    size: 19,
    fill: theme.ink,
    weight: 620,
  }));

  // Pair construction audit
  out.push(rect(1090, 805, 400, 710, {
    fill: theme.panel,
    stroke: theme.stroke,
    strokeWidth: 2,
    radius: 28,
  }));
  out.push(panelTitle(theme, 1125, 850, "PAIR CONSTRUCTION", 4));
  out.push(text(1125, 960, "144", {
    size: 72,
    fill: theme.ink,
    weight: 900,
  }));
  out.push(text(1262, 943, "TERMINAL", {
    size: 17,
    fill: theme.muted,
    weight: 850,
    letterSpacing: 1.2,
  }));
  out.push(text(1262, 971, "ROLLOUTS", {
    size: 17,
    fill: theme.muted,
    weight: 850,
    letterSpacing: 1.2,
  }));
  out.push(line(1125, 1005, 1455, 1005, { stroke: theme.stroke, strokeWidth: 2 }));

  const auditRows = [
    ["90", "verifier-admitted rollouts", theme.positive],
    ["72", "used in matched pairs", theme.positive],
    ["18", "admitted but unpaired", theme.accent],
    ["54", "invalid / unscored excluded", theme.negative],
  ];
  auditRows.forEach(([count, label, color], index) => {
    const y = 1065 + index * 68;
    out.push(text(1125, y, count, { size: 32, fill: color, weight: 900 }));
    out.push(text(1205, y - 3, label, {
      size: 17,
      fill: theme.ink,
      weight: 620,
    }));
  });
  out.push(rect(1125, 1360, 330, 124, { fill: theme.panel2, radius: 14 }));
  out.push(text(1145, 1392, "MATCHING RULE", {
    size: 14,
    fill: theme.accent,
    weight: 900,
    letterSpacing: 1,
  }));
  out.push(text(1145, 1422, "same task + same trial", {
    size: 15,
    fill: theme.muted,
    weight: 600,
  }));
  out.push(text(1145, 1452, "both verifier-admitted", {
    size: 15,
    fill: theme.muted,
    weight: 600,
  }));

  // Cleared complete pairs
  out.push(rect(110, 1555, 665, 410, {
    fill: theme.panel,
    stroke: theme.stroke,
    strokeWidth: 2,
    radius: 28,
  }));
  out.push(panelTitle(theme, 145, 1600, "CLEARED COMPLETE PAIRS", 5));
  out.push(text(740, 1600, `${decisions.cleared} / ${complete.task_count} COMPLETE TASKS`, {
    size: 16,
    fill: theme.positive,
    weight: 850,
    anchor: "end",
    letterSpacing: 1.5,
  }));
  clearedTasks.forEach((task, index) => {
    const y = 1700 + index * 94;
    out.push(text(145, y, taskLabels[task.task_id] ?? task.task_id, {
      size: 25,
      fill: theme.ink,
      weight: 740,
    }));
    out.push(text(740, y, pp(task.observed_score_lift), {
      size: 28,
      fill: theme.positive,
      weight: 900,
      anchor: "end",
    }));
    out.push(line(145, y + 30, 740, y + 30, { stroke: theme.stroke, strokeWidth: 1 }));
  });
  out.push(text(145, 1915, `${reasons.no_effect} no effect · ${reasons.unstable_result} unstable · ${decisions.rejected} rejected.`, {
    size: 18,
    fill: theme.muted,
    weight: 650,
  }));
  out.push(text(145, 1942, "15 incomplete tasks excluded from task-level effects.", {
    size: 18,
    fill: theme.muted,
    weight: 650,
  }));

  // Method
  out.push(rect(805, 1555, 685, 410, {
    fill: theme.panel,
    stroke: theme.stroke,
    strokeWidth: 2,
    radius: 28,
  }));
  out.push(panelTitle(theme, 840, 1600, "METHOD", 6));
  out.push(step(theme, 840, 1640, 170, "TASKS", "24"));
  out.push(text(1027, 1695, "×", { size: 28, fill: theme.accent, weight: 900, anchor: "middle" }));
  out.push(step(theme, 1045, 1640, 170, "ARMS", "2"));
  out.push(text(1232, 1695, "×", { size: 28, fill: theme.accent, weight: 900, anchor: "middle" }));
  out.push(step(theme, 1250, 1640, 205, "TRIALS / ARM", "3"));

  out.push(step(theme, 840, 1760, 190, "EXECUTED", "144"));
  out.push(text(1048, 1815, "→", { size: 30, fill: theme.accent, weight: 900, anchor: "middle" }));
  out.push(step(theme, 1065, 1760, 190, "MATCHED", `${paired.rollout_count}`, theme.positive));
  out.push(text(1273, 1815, "→", { size: 30, fill: theme.accent, weight: 900, anchor: "middle" }));
  out.push(step(theme, 1290, 1760, 165, "GATE", `${decisions.cleared} / ${decisions.held} / ${decisions.rejected}`, theme.accent));

  out.push(text(840, 1900, "90 verifier-admitted · 18 unpaired rollouts excluded from effect", {
    size: 16,
    fill: theme.muted,
    weight: 620,
  }));
  out.push(text(840, 1932, "Task truth = executed verifier · release gate = complete 3×3 tasks only.", {
    size: 16,
    fill: theme.muted,
    weight: 620,
  }));

  // Conclusion
  out.push(rect(110, 2005, 1380, 118, {
    fill: theme.accent,
    radius: 24,
  }));
  out.push(text(145, 2048, "CONCLUSION / 结论", {
    size: 17,
    fill: theme.bg,
    weight: 900,
    letterSpacing: 2.5,
  }));
  out.push(text(145, 2093, `Across ${paired.pair_count} matched pairs: ${pct(baseline.value)} → ${pct(candidate.value)} (${pp(paired.observed_lift)}); directional, not conclusive (p=${paired.mcnemar_exact_p_value.toFixed(3)}).`, {
    size: 24,
    fill: theme.bg,
    weight: 800,
  }));

  // Footer
  out.push(text(110, 2170, `XiaoBaOS · ${paired.pair_count} matched pairs · ${paired.task_count} tasks represented · complete-case paired analysis`, {
    size: 16,
    fill: theme.muted,
    weight: 600,
  }));
  out.push(text(1490, 2170, "github.com/fightheyyy/barena", {
    size: 16,
    fill: theme.accent,
    weight: 800,
    anchor: "end",
  }));
  out.push(text(110, 2195, `Validation ${report.validation_id} · 24-task public subset, not the full 87-task leaderboard`, {
    size: 13,
    fill: theme.muted,
    weight: 500,
  }));
  out.push("</svg>");
  return out.join("\n");
}

for (const theme of themes) {
  fs.writeFileSync(path.join(here, `barena-skillsbench-${theme.id}.svg`), createPoster(theme));
}

const manifest = {
  schema: "barena.poster_export.v1",
  generated_at: new Date().toISOString(),
  source_report: path.relative(here, reportPath),
  source_validation_id: report.validation_id,
  dimensions: { width, height },
  exports: themes.map((theme) => ({
    id: theme.id,
    svg: `barena-skillsbench-${theme.id}.svg`,
    png: `barena-skillsbench-${theme.id}.png`,
  })),
  exact_content: {
    planned_rollouts: report.plan.planned_rollouts,
    terminal_rollouts: report.evidence.imported_result_count,
    raw_numeric_rewards: report.evidence.raw_scored_result_count,
    verifier_admitted_rollouts: report.evidence.scored_result_count,
    excluded_rollouts: report.evidence.unscored_result_count,
    invalidated_numeric_rewards: report.evidence.invalidated_result_count,
    raw_unscored_rollouts: report.evidence.raw_unscored_result_count,
    complete_task_count: report.evidence.complete_task_count,
    paired_trials: report.aggregate.paired_trials,
    complete_tasks: report.aggregate.complete_tasks,
    evidence_inventory: {
      baseline: report.aggregate.baseline,
      candidate: report.aggregate.candidate,
      decisions: report.aggregate.decisions,
      decision_reasons: report.aggregate.decision_reasons,
    },
  },
  provenance:
    "All text, labels, and chart values are deterministically rendered from results/latest.json. No generated imagery or inferred claims are used.",
};

fs.writeFileSync(path.join(here, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
