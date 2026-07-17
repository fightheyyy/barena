import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadAgentE2ECase, runAgentE2ECase } from "../e2e/case-runner";
import { EvaluatorRuntime, TargetAdapter } from "../e2e/types";
import { XiaoBaEvaluatorRuntime } from "../evaluators/xiaoba-evaluator-runtime";
import { OpenClawTargetAdapter } from "../targets/openclaw-target-adapter";
import { ensureDir, hashDirectory, writeJson } from "../utils/fs";
import { aggregateSkillEvaluation } from "./aggregate";
import {
  CasePurpose,
  EvaluationRunRef,
  SkillEvaluationCase,
  SkillEvaluationRequestV1,
  SkillEvaluationResultV1,
  SkillSelection,
} from "./types";

export interface RunSkillEvaluationInput {
  skillPath: string;
  cases: Array<string | SkillEvaluationCase>;
  attemptsPerArm?: number;
  runsRoot?: string;
  evaluator?: EvaluatorRuntime;
  targetAdapter?: TargetAdapter;
}

export async function runSkillEvaluation(input: RunSkillEvaluationInput): Promise<SkillEvaluationResultV1> {
  const candidate = loadSkillSelection(input.skillPath);
  const cases = normalizeCases(input.cases);
  const attemptsPerArm = input.attemptsPerArm ?? 2;
  if (!Number.isInteger(attemptsPerArm) || attemptsPerArm < 1 || attemptsPerArm > 11) {
    throw new Error("attemptsPerArm must be an integer from 1 to 11");
  }
  if (cases.length === 0) throw new Error("At least one case is required");

  const evaluationId = createEvaluationId();
  const evaluationRoot = path.resolve(input.runsRoot ?? "runs", evaluationId);
  ensureDir(evaluationRoot);
  const request: SkillEvaluationRequestV1 = {
    schema: "barena.skill_evaluation_request.v1",
    evaluation_id: evaluationId,
    created_at: new Date().toISOString(),
    target: "openclaw",
    evaluator_runtime: "xiaoba-cli",
    baseline: { mode: "none" },
    candidate,
    cases,
    attempts_per_arm: attemptsPerArm,
  };
  const requestRef = path.join(evaluationRoot, "evaluation-request.json");
  writeJson(requestRef, request);

  const evaluator = input.evaluator ?? new XiaoBaEvaluatorRuntime();
  const baselineRuns = await runArm({
    arm: "baseline",
    selection: request.baseline,
    cases,
    attemptsPerArm,
    evaluationRoot,
    evaluator,
    targetAdapter: input.targetAdapter,
  });
  const candidateRuns = await runArm({
    arm: "candidate",
    selection: request.candidate,
    cases,
    attemptsPerArm,
    evaluationRoot,
    evaluator,
    targetAdapter: input.targetAdapter,
  });
  const result = aggregateSkillEvaluation({ request, requestRef, baselineRuns, candidateRuns });
  const resultRef = path.join(evaluationRoot, "skill-evaluation.json");
  writeJson(resultRef, result);
  ensureDir(path.join(evaluationRoot, "reports"));
  writeJson(path.join(evaluationRoot, "reports", "report.json"), result);
  fs.writeFileSync(path.join(evaluationRoot, "reports", "report.md"), renderEvaluationReport(result), "utf8");
  return result;
}

export function loadSkillSelection(skillPath: string): Extract<SkillSelection, { mode: "path" }> {
  const sourcePath = path.resolve(skillPath);
  const manifestPath = path.join(sourcePath, "SKILL.md");
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
    throw new Error(`Skill directory does not exist: ${sourcePath}`);
  }
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
    throw new Error(`Skill directory must contain SKILL.md: ${sourcePath}`);
  }
  const manifest = fs.readFileSync(manifestPath, "utf8");
  const name = frontmatterName(manifest) ?? path.basename(sourcePath);
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error("Skill frontmatter name must contain only letters, numbers, dot, underscore, or dash");
  }
  return { mode: "path", name, source_path: sourcePath, fingerprint: hashDirectory(sourcePath) };
}

function normalizeCases(cases: Array<string | SkillEvaluationCase>): SkillEvaluationCase[] {
  return cases.map((entry) => typeof entry === "string"
    ? { case_path: path.resolve(entry), purpose: "effectiveness" as CasePurpose }
    : { case_path: path.resolve(entry.case_path), purpose: entry.purpose });
}

async function runArm(input: {
  arm: "baseline" | "candidate";
  selection: SkillSelection;
  cases: SkillEvaluationCase[];
  attemptsPerArm: number;
  evaluationRoot: string;
  evaluator: EvaluatorRuntime;
  targetAdapter?: TargetAdapter;
}): Promise<EvaluationRunRef[]> {
  const refs: EvaluationRunRef[] = [];
  for (const caseEntry of input.cases) {
    const loaded = loadAgentE2ECase(caseEntry.case_path);
    const caseDefinition = { ...loaded.caseDefinition, replays: input.attemptsPerArm - 1 };
    const armRunsRoot = path.join(input.evaluationRoot, "arms", input.arm, loaded.caseDefinition.case_id);
    const targetAdapter = input.targetAdapter ?? new OpenClawTargetAdapter({
      envAllowlist: loaded.caseDefinition.target.env_allowlist,
    });
    const scorecard = await runAgentE2ECase(caseDefinition, loaded.caseBaseDir, {
      runsRoot: armRunsRoot,
      evaluator: input.evaluator,
      targetAdapter,
      skill: input.selection,
    });
    refs.push({
      arm: input.arm,
      case_id: loaded.caseDefinition.case_id,
      purpose: caseEntry.purpose,
      run_id: scorecard.run_id,
      scorecard_ref: path.join(armRunsRoot, scorecard.run_id, "reviewer", "scorecard.json"),
      scorecard,
    });
  }
  return refs;
}

function frontmatterName(manifest: string): string | undefined {
  const match = manifest.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return undefined;
  const name = match[1].match(/^name:\s*["']?([^\s"']+)["']?\s*$/m)?.[1];
  return name?.trim();
}

function createEvaluationId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `skill-eval-${timestamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function renderEvaluationReport(result: SkillEvaluationResultV1): string {
  const percent = (value: number | null): string => value === null ? "unavailable" : `${Math.round(value * 100)}%`;
  return [
    `# Barena Skill Evaluation: ${result.candidate.selection.mode === "path" ? result.candidate.selection.name : "candidate"}`,
    "",
    `- Decision: ${result.decision}`,
    `- Reason: ${result.reason_code}`,
    `- Truth: ${result.outcome_truth.status}`,
    `- Baseline pass rate: ${percent(result.effectiveness.baseline_pass_rate.value)}`,
    `- Candidate pass rate: ${percent(result.effectiveness.candidate_pass_rate.value)}`,
    `- Observed lift: ${percent(result.effectiveness.observed_lift)}`,
    `- Candidate stability: ${result.quality.candidate}`,
    `- Required evidence complete: ${result.quality.required_evidence_complete}`,
    "",
    result.summary,
    "",
  ].join("\n");
}
