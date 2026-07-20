import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startGuide, type GuideIO } from "../src/cli/guide";
import { runCli } from "../src/cli/main";
import { writeJson } from "../src/utils/fs";

test("guided OpenClaw flow prepares a Skill snapshot and exact command without executing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-guide-"));
  const skillPath = path.join(root, "candidate-skill");
  fs.mkdirSync(skillPath);
  fs.writeFileSync(
    path.join(skillPath, "SKILL.md"),
    "---\nname: candidate-skill\n---\nCreate the requested result artifact.\n",
    "utf8"
  );
  const casePath = path.join(root, "case.json");
  writeJson(casePath, {
    schema: "barena.agent_e2e_case.v1",
    case_id: "guide-openclaw",
    target: { adapter: "openclaw", agent: "main", env_allowlist: ["OPENAI_API_KEY"] },
    task: { prompt: "Create result.txt containing GUIDE_OK." },
    assertions: { artifacts: [{ path: "result.txt", contains: "GUIDE_OK" }] },
    replays: 0,
    timeout_ms: 5_000,
    isolation: { level: "policy_only", network: "allowlisted", writable_roots: ["workspace"] },
  });

  const subjectsRoot = path.join(root, "subjects");
  const runsRoot = path.join(root, "runs");
  const selections = ["1", "1", "1"];
  const io = new ScriptedGuideIO((prompt) => {
    if (prompt.startsWith("Select [")) return selections.shift() ?? failUnexpectedPrompt(prompt);
    if (prompt.startsWith("Local Skill directory")) return skillPath;
    if (prompt.startsWith("Skill ID")) return "";
    if (prompt.startsWith("OpenClaw command/path")) return "";
    if (prompt.startsWith("OpenClaw agent ID")) return "";
    if (prompt.startsWith("Allowed environment variable names")) return "";
    if (prompt.startsWith("Case JSON path")) return casePath;
    if (prompt.startsWith("How many attempts per arm?")) return "2";
    if (prompt.startsWith("Prepare this evaluation?")) return "y";
    if (prompt.startsWith("Run the evaluation now?")) return "n";
    return failUnexpectedPrompt(prompt);
  });
  const executed: string[][] = [];

  const exitCode = await startGuide({
    cwd: root,
    subjectsRoot,
    runsRoot,
    io,
    execute: async (argv) => {
      executed.push(argv);
      return 0;
    },
  });

  const snapshotPath = path.join(subjectsRoot, "candidate-skill");
  const expectedCommand = `barena evaluate skill ${snapshotPath} --target openclaw --case ${casePath} --attempts 2 --runs-root ${runsRoot}`;
  assert.equal(exitCode, 0);
  assert.deepEqual(executed, []);
  assert.equal(fs.existsSync(path.join(snapshotPath, "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(snapshotPath, "subject-manifest.json")), true);
  assert.match(io.output, /Baseline: same task with no candidate Skill/);
  assert.match(io.output, /Candidate: same task with candidate-skill/);
  assert.match(io.output, /Evidence: boundary\/workspace\/verifier \(confidence capped at medium\)/);
  assert.match(io.output, /Effective agent\/profile: main/);
  assert.match(io.output, /Environment names passed: OPENAI_API_KEY/);
  assert.match(io.output, /Network declaration: allowlisted; isolation=policy_only/);
  assert.match(io.output, /Maximum target sessions: 2 per arm \/ 4 total/);
  assert.match(io.output, new RegExp(escapeRegExp(expectedCommand)));
  assert.match(io.output, /Prepared successfully\. Run the command above when ready\./);
});

test("guide is fail-fast under non-interactive IO", async () => {
  let output = "";
  const exitCode = await startGuide({
    io: {
      interactive: false,
      ask: async () => assert.fail("non-interactive guide must not prompt"),
      write: (message) => { output += message; },
      close: () => undefined,
    },
    execute: async () => 0,
  });
  assert.equal(exitCode, 3);
  assert.match(output, /requires an interactive terminal/);
});

test("existing snapshots require explicit replacement and default to no", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-guide-existing-"));
  const skillPath = createSkill(root, "candidate-skill", "new source\n");
  const casePath = createOpenClawCase(root, "existing-snapshot-case");
  const subjectsRoot = path.join(root, "subjects");
  const snapshotPath = path.join(subjectsRoot, "candidate-skill");
  fs.mkdirSync(snapshotPath, { recursive: true });
  fs.writeFileSync(path.join(snapshotPath, "SKILL.md"), "old snapshot\n", "utf8");
  const selections = ["1", "1", "1"];
  const io = new ScriptedGuideIO((prompt) => {
    if (prompt.startsWith("Select [")) return selections.shift() ?? failUnexpectedPrompt(prompt);
    if (prompt.startsWith("Local Skill directory")) return skillPath;
    if (prompt.startsWith("Skill ID")) return "";
    if (prompt.startsWith("OpenClaw command/path")) return "";
    if (prompt.startsWith("Case JSON path")) return casePath;
    if (prompt.startsWith("How many attempts per arm?")) return "1";
    if (prompt.startsWith("Replace the existing snapshot")) return "";
    return failUnexpectedPrompt(prompt);
  });

  const exitCode = await startGuide({
    cwd: root,
    subjectsRoot,
    runsRoot: path.join(root, "runs"),
    io,
    execute: async () => assert.fail("executor must not run"),
  });

  assert.equal(exitCode, 0);
  assert.equal(fs.readFileSync(path.join(snapshotPath, "SKILL.md"), "utf8"), "old snapshot\n");
  assert.match(io.output, /replacement requires explicit confirmation/);
  assert.match(io.output, /Replace the existing snapshot.*\[y\/N\]/s);
  assert.match(io.output, /Nothing changed/);
});

test("invalid input retries locally and q cancels before filesystem writes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-guide-retry-"));
  const skillPath = createSkill(root, "candidate-skill", "candidate\n");
  const subjectsRoot = path.join(root, "subjects");
  const answers = ["9", "1"];
  const io = new ScriptedGuideIO((prompt) => {
    if (prompt.startsWith("Select [")) return answers.shift() ?? failUnexpectedPrompt(prompt);
    if (prompt.startsWith("Local Skill directory")) return skillPath;
    if (prompt.startsWith("Skill ID")) return "q";
    return failUnexpectedPrompt(prompt);
  });

  const exitCode = await startGuide({
    cwd: root,
    subjectsRoot,
    io,
    execute: async () => assert.fail("executor must not run"),
  });

  assert.equal(exitCode, 0);
  assert.equal(fs.existsSync(subjectsRoot), false);
  assert.match(io.output, /Choose a number from 1 to 3/);
  assert.match(io.output, /Cancelled\. Nothing changed/);
});

test("guide blocks overlapping source and snapshot roots before preparation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-guide-overlap-"));
  fs.writeFileSync(path.join(root, "SKILL.md"), "---\nname: overlap-skill\n---\n", "utf8");
  const selections = ["1"];
  const io = new ScriptedGuideIO((prompt) => {
    if (prompt.startsWith("Select [")) return selections.shift() ?? failUnexpectedPrompt(prompt);
    if (prompt.startsWith("Local Skill directory")) return root;
    if (prompt.startsWith("Skill ID")) return "overlap-skill";
    return failUnexpectedPrompt(prompt);
  });

  const exitCode = await startGuide({
    cwd: root,
    io,
    execute: async () => assert.fail("executor must not run"),
  });

  assert.equal(exitCode, 3);
  assert.equal(fs.existsSync(path.join(root, "subjects")), false);
  assert.match(io.output, /Skill source and snapshot destination overlap/);
  assert.match(io.output, /--subjects-root/);
});

test("starter case conflicts are detected before snapshot preparation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-guide-conflict-"));
  const skillPath = createSkill(root, "candidate-skill", "candidate\n");
  const casePath = path.join(root, "existing-case.json");
  fs.writeFileSync(casePath, "do not overwrite\n", "utf8");
  const subjectsRoot = path.join(root, "subjects");
  const selections = ["1", "1", "2"];
  let casePathPrompts = 0;
  const io = new ScriptedGuideIO((prompt) => {
    if (prompt.startsWith("Select [")) return selections.shift() ?? failUnexpectedPrompt(prompt);
    if (prompt.startsWith("Local Skill directory")) return skillPath;
    if (prompt.startsWith("Skill ID")) return "";
    if (prompt.startsWith("OpenClaw command/path")) return "";
    if (prompt.startsWith("Case ID")) return "conflict-case";
    if (prompt.startsWith("Task prompt")) return "Create result.txt";
    if (prompt.startsWith("Expected artifact path")) return "";
    if (prompt.startsWith("Text that must appear")) return "OK";
    if (prompt.startsWith("Write case to")) return casePathPrompts++ === 0 ? casePath : "q";
    return failUnexpectedPrompt(prompt);
  });

  const exitCode = await startGuide({
    cwd: root,
    subjectsRoot,
    io,
    execute: async () => assert.fail("executor must not run"),
  });

  assert.equal(exitCode, 0);
  assert.equal(fs.existsSync(subjectsRoot), false);
  assert.equal(fs.readFileSync(casePath, "utf8"), "do not overwrite\n");
  assert.match(io.output, /Refusing to overwrite an existing case/);
});

test("portable target and case mismatch returns CLI usage exit 3", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-cli-mismatch-"));
  const skillPath = path.join(root, "candidate-skill");
  fs.mkdirSync(skillPath);
  fs.writeFileSync(path.join(skillPath, "SKILL.md"), "---\nname: candidate-skill\n---\n", "utf8");
  const casePath = path.join(root, "case.json");
  writeJson(casePath, {
    schema: "barena.agent_e2e_case.v1",
    case_id: "portable-runtime-mismatch",
    target: { adapter: "portable", runtime: "other-runtime" },
    task: { prompt: "This case must fail before target execution." },
    assertions: { artifacts: [{ path: "result.txt", contains: "NEVER" }] },
    replays: 0,
    timeout_ms: 5_000,
    isolation: { level: "policy_only", network: "disabled", writable_roots: ["workspace"] },
  });

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
  try {
    const exitCode = await runCli([
      "evaluate",
      "skill",
      skillPath,
      "--target",
      "hermes",
      "--target-command",
      path.join(root, "driver-that-must-not-run"),
      "--case",
      casePath,
      "--runs-root",
      path.join(root, "runs"),
    ]);
    assert.equal(exitCode, 3);
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /target\.adapter=portable and target\.runtime=hermes/);
  assert.equal(fs.existsSync(path.join(root, "runs")), false);
});

class ScriptedGuideIO implements GuideIO {
  readonly interactive = true;
  output = "";
  private readonly answer: (prompt: string) => string;

  constructor(answer: (prompt: string) => string) {
    this.answer = answer;
  }

  async ask(prompt: string): Promise<string> {
    this.output += prompt;
    return this.answer(prompt);
  }

  write(message: string): void {
    this.output += message;
  }

  close(): void {
    // The guide does not own injected IO.
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createSkill(root: string, id: string, body: string): string {
  const skillPath = path.join(root, id);
  fs.mkdirSync(skillPath, { recursive: true });
  fs.writeFileSync(path.join(skillPath, "SKILL.md"), `---\nname: ${id}\n---\n${body}`, "utf8");
  return skillPath;
}

function createOpenClawCase(root: string, caseId: string): string {
  const casePath = path.join(root, `${caseId}.json`);
  writeJson(casePath, {
    schema: "barena.agent_e2e_case.v1",
    case_id: caseId,
    target: { adapter: "openclaw", agent: "main", env_allowlist: ["OPENAI_API_KEY"] },
    task: { prompt: "Create result.txt containing GUIDE_OK." },
    assertions: { artifacts: [{ path: "result.txt", contains: "GUIDE_OK" }] },
    replays: 7,
    timeout_ms: 5_000,
    isolation: { level: "policy_only", network: "allowlisted", writable_roots: ["workspace"] },
  });
  return casePath;
}

function failUnexpectedPrompt(prompt: string): never {
  assert.fail(`Unexpected guide prompt: ${prompt}`);
}
