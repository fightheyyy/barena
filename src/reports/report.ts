import fs from "node:fs";
import path from "node:path";
import type { Scorecard } from "../domain/types";
import {
  renderAgentE2EReport,
  renderEvaluationReport,
  renderXiaoBaCapabilityReport,
} from "./run-renderers";
import { loadRunRecord, type CatalogRun } from "../runs/catalog";
import {
  isCompleteAgentE2ERun,
  isCompleteLegacyClearanceRun,
  isCompleteSkillEvaluationRun,
  isCompleteXiaoBaCapabilityRun,
  stringValue,
} from "../runs/type-guards";
import { writeJson } from "../utils/fs";

export function writeReports(scorecard: Scorecard, runRoot: string): { json: string; markdown: string } {
  const reportsRoot = path.join(runRoot, "reports");
  fs.mkdirSync(reportsRoot, { recursive: true });
  const jsonPath = path.join(reportsRoot, "report.json");
  const markdownPath = path.join(reportsRoot, "report.md");

  writeJson(jsonPath, scorecard);
  fs.writeFileSync(markdownPath, renderMarkdown(scorecard), "utf8");
  return { json: jsonPath, markdown: markdownPath };
}

export function loadScorecard(runId: string, runsRoot = "runs"): Scorecard {
  const run = loadRunRecord(runId, runsRoot);
  if (run.kind !== "legacy_clearance" || !isCompleteLegacyClearanceRun(run.result)) {
    throw new Error(`Run ${runId} is not a complete legacy clearance scorecard`);
  }
  return run.result;
}

export function renderRunMarkdown(run: CatalogRun): string {
  if (run.kind === "legacy_clearance" && isCompleteLegacyClearanceRun(run.result)) {
    return renderMarkdown(run.result);
  }
  if (run.kind === "agent_e2e" && isCompleteAgentE2ERun(run.result)) {
    return renderAgentE2EReport(run.result);
  }
  if (run.kind === "skill_evaluation" && isCompleteSkillEvaluationRun(run.result)) {
    return renderEvaluationReport(run.result);
  }
  if (run.kind === "xiaoba_capability" && isCompleteXiaoBaCapabilityRun(run.result)) {
    return renderXiaoBaCapabilityReport(run.result);
  }
  return renderPartialRunMarkdown(run);
}

export function renderMarkdown(scorecard: Scorecard): string {
  const issues = scorecard.issues.length
    ? scorecard.issues
        .map((issue) => `- ${issue.severity.toUpperCase()} ${issue.family}: ${issue.summary}`)
        .join("\n")
    : "- None";
  const agentTarget = scorecard.agent_target
    ? `
## Agent Target

- Target: ${scorecard.agent_target.display_name} (${scorecard.agent_target.target_id})
- Category: ${scorecard.agent_target.category}
- CI focus: ${scorecard.agent_target.ci_focus.join(", ") || "n/a"}
- Risk focus: ${scorecard.agent_target.risk_focus.join(", ") || "n/a"}
`
    : "";

  return `# Barena Scorecard

Subject: ${scorecard.subject_id}
Subject type: ${scorecard.subject_type}
Run: ${scorecard.run_id}
Decision: ${scorecard.decision}
Status: ${scorecard.status}

## Summary

${scorecard.summary}

${agentTarget}

## Scores

- Task success: ${scorecard.scores.task_success}
- Stability: ${scorecard.scores.stability}
- Tool use quality: ${scorecard.scores.tool_use_quality}
- Safety: ${scorecard.scores.safety}

## Scan

- Decision: ${scorecard.scan_summary.decision}
- Findings: ${scorecard.scan_summary.finding_count}
- Unsafe: ${scorecard.scan_summary.unsafe_count}
- Blocking: ${scorecard.scan_summary.blocking_count}

## Replay

- Planned: ${scorecard.replay_attempts.planned}
- Completed: ${scorecard.replay_attempts.completed}
- Passed: ${scorecard.replay_attempts.pass_count}
- Failed: ${scorecard.replay_attempts.fail_count}
- Blocked: ${scorecard.replay_attempts.blocked_count}

## Issues

${issues}
`;
}

function renderPartialRunMarkdown(run: CatalogRun): string {
  const summary = stringValue(run.result.summary) ?? "No summary was recorded.";
  const warnings = run.warnings.length
    ? run.warnings.map((warning) => `- ${warning}`).join("\n")
    : "- None";
  return [
    `# Barena Run: ${run.run_id}`,
    "",
    `- Kind: ${run.kind}`,
    `- Schema: ${run.schema}`,
    `- Decision: ${run.decision}`,
    `- Status: ${run.status}`,
    `- Reason: ${run.reason}`,
    `- Catalog health: ${run.health}`,
    "",
    "## Summary",
    "",
    summary,
    "",
    "## Catalog warnings",
    "",
    warnings,
    "",
  ].join("\n");
}
