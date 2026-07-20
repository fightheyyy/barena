import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  EvaluatorRunRequest,
  EvaluatorRunResult,
  EvaluatorRuntime,
  RuntimeProbeResult,
  TargetAdapter,
  TargetInvocationRequest,
  TargetInvocationResult,
} from "../src/e2e/types";
import { runSkillEvaluation } from "../src/evaluation/run-skill-evaluation";
import { prepareStaticAdmission } from "../src/evaluation/static-admission";
import {
  createXiaoBaNativeRoleRequest,
  createXiaoBaNativeSkillRequest,
} from "../src/evaluation/xiaoba-native-input";
import { runXiaoBaNativeEvaluation } from "../src/evaluation/xiaoba-native-runner";
import type { XiaoBaCommandRequest, XiaoBaCommandResult, XiaoBaCommandRunner } from "../src/evaluation/xiaoba-native-types";
import { hashDirectory } from "../src/utils/fs";

const repoRoot = path.resolve(__dirname, "..");
const fixtureRolesRoot = path.join(repoRoot, "test", "fixtures", "xiaoba-native", "roles");
const unsafeSkillPath = path.join(repoRoot, "test", "fixtures", "skills", "unsafe-skill");
const nativeCasePath = path.join(repoRoot, "docs", "cases", "xiaoba-skill-artifact.json");
const nativeRoleCasePath = path.join(repoRoot, "docs", "cases", "xiaoba-role-artifact.json");

test("shared static admission persists relation-aware scan evidence and enforces accepted finding IDs", async (t) => {
  await t.test("candidate unsafe is rejected while common unsafe is held", () => {
    const root = tempRoot("barena-static-relations-");
    const clean = subject(root, "clean", "safe content\n");
    const unsafe = subject(root, "unsafe", "BARENA_UNSAFE\n");

    const candidate = prepareStaticAdmission({
      evaluation_root: path.join(root, "candidate-evaluation"),
      subjects: [
        admissionSubject("common", "role", "shared-role", clean),
        admissionSubject("candidate", "skill", "candidate-skill", unsafe),
      ],
    });
    assert.equal(candidate.report.decision, "rejected");
    assert.equal(candidate.report.reason_code, "static_admission_candidate_unsafe");

    const common = prepareStaticAdmission({
      evaluation_root: path.join(root, "common-evaluation"),
      subjects: [
        admissionSubject("common", "role", "shared-role", unsafe),
        admissionSubject("candidate", "skill", "candidate-skill", clean),
      ],
    });
    assert.equal(common.report.decision, "held");
    assert.equal(common.report.reason_code, "static_admission_common_unsafe");

    const baseline = prepareStaticAdmission({
      evaluation_root: path.join(root, "baseline-evaluation"),
      subjects: [
        admissionSubject("baseline", "role", "baseline-role", unsafe),
        admissionSubject("candidate", "role", "candidate-role", clean),
      ],
    });
    assert.equal(baseline.report.decision, "held");
    assert.equal(baseline.report.reason_code, "static_admission_baseline_unsafe");

    for (const outcome of [candidate, common, baseline]) {
      assert.equal(outcome.report.evidence_complete, true);
      assert.equal(outcome.report.evidence_refs.length, outcome.report.subjects.length + 1);
      assert.equal(outcome.report.evidence_refs.every((ref) => fs.existsSync(ref)), true);
      assert.equal(outcome.report.evidence_refs.every((ref) => ref.includes(`${path.sep}preflight${path.sep}admission${path.sep}`)), true);
      assert.equal(outcome.report.subjects.every((entry) => entry.scan.findings.every((finding) =>
        finding.finding_id.startsWith(`${entry.relation}.${entry.subject_kind}.${entry.subject_id}.`)
      )), true);
    }
  });

  await t.test("every review-required finding must be explicitly accepted", () => {
    const root = tempRoot("barena-static-review-");
    const warning = subject(root, "warning", "TOKEN\n");
    const input = admissionSubject("candidate", "skill", "review-skill", warning);
    const held = prepareStaticAdmission({
      evaluation_root: path.join(root, "held-evaluation"),
      subjects: [input],
    });
    assert.equal(held.report.decision, "held");
    assert.equal(held.report.reason_code, "static_admission_review_required");
    assert.equal(held.report.unaccepted_finding_ids.length, 1);

    const acceptedId = held.report.unaccepted_finding_ids[0];
    const passed = prepareStaticAdmission({
      evaluation_root: path.join(root, "passed-evaluation"),
      subjects: [input],
      accepted_finding_ids: [acceptedId],
    });
    assert.equal(passed.report.decision, "pass");
    assert.equal(passed.report.reason_code, "static_admission_passed");
    assert.deepEqual(passed.report.accepted_finding_ids, [acceptedId]);
    assert.deepEqual(passed.report.unaccepted_finding_ids, []);
  });

  await t.test("snapshot failures persist evidence and hold closed", () => {
    const root = tempRoot("barena-static-snapshot-failure-");
    const source = subject(root, "source", "safe content\n");
    const linked = path.join(root, "linked-source");
    fs.symlinkSync(source, linked, "dir");
    const result = prepareStaticAdmission({
      evaluation_root: path.join(root, "evaluation"),
      subjects: [admissionSubject("candidate", "skill", "linked-skill", linked)],
    });

    assert.equal(result.report.decision, "held");
    assert.equal(result.report.reason_code, "static_admission_snapshot_failed");
    assert.equal(result.report.evidence_complete, false);
    assert.equal(result.report.evidence_refs.every((ref) => fs.existsSync(ref)), true);
  });
});

test("XiaoBa native admission rejects an unsafe Skill before probe or target commands", async () => {
  const root = tempRoot("barena-static-xiaoba-");
  const projectRoot = path.join(root, "xiaoba-project");
  fs.mkdirSync(path.join(projectRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "dist", "index.js"), "#!/usr/bin/env node\n", "utf8");
  const binaryPath = path.join(root, "xiaoba");
  fs.writeFileSync(binaryPath, "#!/usr/bin/env node\n", "utf8");
  const commandRunner = new RejectingXiaoBaCommandRunner();
  const request = createXiaoBaNativeSkillRequest({
    roleId: "inherit-base-role",
    skillPath: unsafeSkillPath,
    casePaths: [nativeCasePath],
    attemptsPerArm: 1,
    binaryPath,
    projectRoot,
    rolesRoot: fixtureRolesRoot,
    passEnv: [],
  });

  const result = await runXiaoBaNativeEvaluation(
    { request, runs_root: path.join(root, "runs") },
    { command_runner: commandRunner }
  );

  assert.equal(commandRunner.requests.length, 0);
  assert.equal(result.decision, "rejected");
  assert.equal(result.reason_code, "static_admission_candidate_unsafe");
  assert.equal(result.admission?.decision, "rejected");
  assert.equal(result.evidence_refs.some((ref) => ref.includes(`${path.sep}preflight${path.sep}admission${path.sep}`)), true);
});

test("XiaoBa native Role admission holds an unsafe baseline before probe or target commands", async () => {
  const root = tempRoot("barena-static-xiaoba-role-");
  const rolesRoot = path.join(root, "roles");
  fs.cpSync(fixtureRolesRoot, rolesRoot, { recursive: true });
  fs.appendFileSync(
    path.join(rolesRoot, "inherit-base-role", "prompts", "fixture-system-prompt.md"),
    "\nBARENA_UNSAFE\n",
    "utf8"
  );
  const projectRoot = path.join(root, "xiaoba-project");
  fs.mkdirSync(path.join(projectRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "dist", "index.js"), "#!/usr/bin/env node\n", "utf8");
  const binaryPath = path.join(root, "xiaoba");
  fs.writeFileSync(binaryPath, "#!/usr/bin/env node\n", "utf8");
  const commandRunner = new RejectingXiaoBaCommandRunner();
  const request = createXiaoBaNativeRoleRequest({
    baselineRoleId: "inherit-base-role",
    candidateRoleId: "candidate-role",
    casePaths: [nativeRoleCasePath],
    attemptsPerArm: 1,
    binaryPath,
    projectRoot,
    rolesRoot,
    passEnv: [],
  });

  const result = await runXiaoBaNativeEvaluation(
    { request, runs_root: path.join(root, "runs") },
    { command_runner: commandRunner }
  );

  assert.equal(commandRunner.requests.length, 0);
  assert.equal(result.decision, "held");
  assert.equal(result.reason_code, "static_admission_baseline_unsafe");
  assert.equal(result.admission?.subjects.some((subject) => subject.relation === "baseline"), true);
  assert.equal(result.admission?.subjects.some((subject) => subject.relation === "candidate"), true);
});

test("OpenClaw paired Skill admission rejects an unsafe candidate before evaluator or target commands", async () => {
  const root = tempRoot("barena-static-openclaw-");
  const casePath = path.join(root, "case.json");
  writeJson(casePath, {
    schema: "barena.agent_e2e_case.v1",
    case_id: "unsafe-static-candidate",
    target: { adapter: "openclaw", agent: "main" },
    task: { prompt: "must not execute" },
    assertions: { artifacts: [{ path: "result.txt", exists: true }] },
    replays: 0,
    timeout_ms: 5_000,
    isolation: { level: "policy_only", network: "disabled", writable_roots: ["workspace"] },
  });
  const evaluator = new RejectingEvaluator();
  const target = new RejectingTargetAdapter();

  const result = await runSkillEvaluation({
    skillPath: unsafeSkillPath,
    cases: [casePath],
    attemptsPerArm: 1,
    runsRoot: path.join(root, "runs"),
    evaluator,
    targetAdapter: target,
  });

  assert.equal(evaluator.probeCalls, 0);
  assert.equal(evaluator.runCalls, 0);
  assert.equal(target.probeCalls, 0);
  assert.equal(target.executeCalls, 0);
  assert.equal(result.decision, "rejected");
  assert.equal(result.reason_code, "static_admission_candidate_unsafe");
  assert.equal(result.admission?.decision, "rejected");
  assert.equal(result.evidence_refs.some((ref) => ref.includes(`${path.sep}preflight${path.sep}admission${path.sep}`)), true);
});

function admissionSubject(
  relation: "baseline" | "common" | "candidate",
  subjectKind: "role" | "skill",
  subjectId: string,
  sourcePath: string
): {
  relation: "baseline" | "common" | "candidate";
  subject_kind: "role" | "skill";
  subject_id: string;
  source_path: string;
  fingerprint: string;
} {
  return {
    relation,
    subject_kind: subjectKind,
    subject_id: subjectId,
    source_path: sourcePath,
    fingerprint: hashDirectory(sourcePath),
  };
}

function subject(root: string, name: string, content: string): string {
  const subjectRoot = path.join(root, name);
  fs.mkdirSync(subjectRoot, { recursive: true });
  fs.writeFileSync(path.join(subjectRoot, "subject.txt"), content, "utf8");
  return subjectRoot;
}

function tempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

class RejectingXiaoBaCommandRunner implements XiaoBaCommandRunner {
  readonly requests: XiaoBaCommandRequest[] = [];

  async run(request: XiaoBaCommandRequest): Promise<XiaoBaCommandResult> {
    this.requests.push(request);
    throw new Error("XiaoBa command must not run after blocked static admission");
  }
}

class RejectingEvaluator implements EvaluatorRuntime {
  readonly id = "xiaoba-cli" as const;
  probeCalls = 0;
  runCalls = 0;

  async probe(): Promise<RuntimeProbeResult> {
    this.probeCalls += 1;
    throw new Error("evaluator probe must not run after blocked static admission");
  }

  async runCase(_request: EvaluatorRunRequest): Promise<EvaluatorRunResult> {
    this.runCalls += 1;
    throw new Error("evaluator run must not run after blocked static admission");
  }
}

class RejectingTargetAdapter implements TargetAdapter {
  readonly id = "openclaw";
  probeCalls = 0;
  executeCalls = 0;

  async probe(): Promise<RuntimeProbeResult> {
    this.probeCalls += 1;
    throw new Error("target probe must not run after blocked static admission");
  }

  async execute(_request: TargetInvocationRequest): Promise<TargetInvocationResult> {
    this.executeCalls += 1;
    throw new Error("target execute must not run after blocked static admission");
  }
}
