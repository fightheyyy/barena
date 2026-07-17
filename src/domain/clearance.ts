import { XiaoBaRuntimeAdapter } from "../adapters/xiaoba/xiaoba-runtime-adapter";
import { inspectTrace } from "../cats/inspector-cat";
import { reviewIssues } from "../cats/reviewer-cat";
import { createUserCatScenarios } from "../cats/user-cat";
import { InspectorIssue, ReplayAttempt, Scorecard, StaticScanFinding, SubjectManifest, VerifierResult } from "./types";
import { createCleanRun } from "../runtime/clean-runtime";
import { scanSubjectDirectory } from "../subjects/scanner";
import { writeJson } from "../utils/fs";
import path from "node:path";
import { runReplayAttempts } from "../replay/replay-runner";
import { runVerifier } from "../verifier/verifier";
import { writeReports } from "../reports/report";

export interface RunClearanceOptions {
  runsRoot?: string;
  replays?: number;
  verifierPath?: string | null;
}

export function runClearance(subject: SubjectManifest, options: RunClearanceOptions = {}): Scorecard {
  const run = createCleanRun(subject, { runsRoot: options.runsRoot });
  const scanReport = scanSubjectDirectory(subject.subject_id, subject.paths.subject_root, path.join(run.paths.scan, "scan-report.json"));
  const scenarios = createUserCatScenarios(subject);
  const adapter = new XiaoBaRuntimeAdapter();
  const staticIssues = scanReport.findings.map((finding, index) => findingToIssue(finding, index));
  const shouldRun = scanReport.decision !== "unsafe" && scanReport.decision !== "blocked";
  const traceRefs: string[] = [];
  let runtimeIssues: InspectorIssue[] = [];
  let replayAttempts: ReplayAttempt[] = [];
  let verifierResults: VerifierResult[] = [];

  if (shouldRun) {
    const runtimeResult = adapter.run({ subject, run, scenarios });
    traceRefs.push(runtimeResult.tracePath);
    runtimeIssues = inspectTrace(run, scenarios, runtimeResult.events);
    replayAttempts = runReplayAttempts(adapter, subject, run, scenarios, options.replays ?? 3);
    verifierResults = runVerifier(options.verifierPath ?? null, run);
  } else {
    writeJson(path.join(run.paths.inspector, "issues.json"), staticIssues);
  }

  const verifierIssues = verifierResults
    .filter((result) => result.status !== "pass")
    .map((result, index): InspectorIssue => ({
      issue_id: `verifier.failure.${index + 1}`,
      scenario_id: "verifier",
      family: "verifier_failure",
      severity: "blocking",
      summary: `Verifier ${result.verifier_id} returned ${result.status}`,
      evidence: [result.stderr || result.stdout || result.command],
      suspected_root_cause: "verifier_failed",
      replay_intent: "Fix the subject or verifier precondition and rerun clearance.",
    }));

  const issues = [...staticIssues, ...runtimeIssues, ...verifierIssues];
  writeJson(path.join(run.paths.inspector, "issues.json"), issues);
  const scorecard = reviewIssues(subject, run, issues, traceRefs, {
    scanReport,
    replayAttempts,
    verifierResults,
  });
  writeReports(scorecard, run.paths.run_root);
  return scorecard;
}

function findingToIssue(finding: StaticScanFinding, index: number): InspectorIssue {
  const severity = finding.severity === "unsafe" ? "unsafe" : finding.severity === "blocking" ? "blocking" : "warning";
  return {
    issue_id: `static.${finding.rule_id}.${index + 1}`,
    scenario_id: "static-scan",
    family: "static_scan",
    severity,
    summary: finding.summary,
    evidence: finding.evidence,
    suspected_root_cause: finding.rule_id,
    replay_intent:
      finding.severity === "unsafe" || finding.severity === "blocking"
        ? "Do not run until the static finding is removed or explicitly reviewed."
        : "Review warning during admission.",
  };
}
