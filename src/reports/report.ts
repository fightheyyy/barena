import path from "node:path";
import { Scorecard } from "../domain/types";
import { readJson, writeJson } from "../utils/fs";
import fs from "node:fs";

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
  return readJson<Scorecard>(path.resolve(runsRoot, runId, "reviewer", "scorecard.json"));
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
