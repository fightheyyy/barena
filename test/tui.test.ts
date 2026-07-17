import assert from "node:assert/strict";
import test from "node:test";
import figlet from "figlet";
import { nextView, renderTui } from "../src/tui/render";
import { TuiState } from "../src/tui/state";

const emptyState: TuiState = {
  subjects_root: "/tmp/barena-subjects",
  runs_root: "/tmp/barena-runs",
  subjects: [],
  runs: [],
};

test("renders a simple text hero with only Barena as ASCII", () => {
  const rendered = renderTui(emptyState, { width: 100, color: false });
  const topAscii = figletLines("AGENTS CAN GROW.", "ANSI Shadow");
  const brand = figletLines("BARENA", "ANSI Shadow");
  const growthAscii = figletLines("MAKES GROWTH REVIEWABLE.", "ANSI Shadow");
  const longestLine = Math.max(...rendered.split("\n").map((line) => line.length));

  assert.equal(rendered.includes("AGENTS CAN GROW."), true);
  assert.equal(rendered.includes(brand[0]), true);
  assert.equal(rendered.includes("MAKES GROWTH REVIEWABLE."), true);
  assert.equal(rendered.includes(topAscii[0]), false);
  assert.equal(rendered.includes(growthAscii[0]), false);
  assert.equal(rendered.includes("trace / replay / arena / scorecard"), true);
  assert.equal(longestLine <= 100, true);
  assert.equal(/\x1b\[/.test(rendered), false);
});

test("colors the hero without adding a background", () => {
  const rendered = renderTui(emptyState, { width: 132, color: true });

  assert.equal(rendered.includes("\x1b[48;"), false);
  assert.equal(rendered.includes("\x1b[38;2;"), false);
  assert.equal(rendered.includes("\x1b[38;5;136m"), true);
  assert.equal(rendered.includes("\x1b[38;5;220m"), true);
  assert.equal(rendered.includes("\x1b[38;5;222m"), true);
  assert.equal(rendered.includes("trace / replay / arena / scorecard"), true);
});

test("cycles TUI views in both directions", () => {
  assert.equal(nextView("overview", 1), "subjects");
  assert.equal(nextView("overview", -1), "commands");
  assert.equal(nextView("commands", 1), "overview");
});

function figletLines(value: string, font: "ANSI Compact" | "ANSI Shadow"): string[] {
  return figlet
    .textSync(value, { font })
    .split("\n")
    .map((item) => item.trimEnd())
    .filter((item) => item.trim().length > 0);
}
