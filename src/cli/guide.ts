import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadAgentE2ECase } from "../e2e/case-runner";
import type { AgentE2ECaseV1 } from "../e2e/types";
import { importGithubSkill } from "../subjects/github-importer";
import { importLocalSkill } from "../subjects/importer";
import { ensureDir, writeJson } from "../utils/fs";
import { EXIT_ERROR, EXIT_SUCCESS, type CliExitCode } from "./exit-codes";

export interface GuideIO {
  readonly interactive: boolean;
  ask(prompt: string): Promise<string>;
  write(message: string): void;
  close(): void;
}

export interface StartGuideOptions {
  execute: (argv: string[]) => Promise<CliExitCode>;
  io?: GuideIO;
  cwd?: string;
  subjectsRoot?: string;
  runsRoot?: string;
}

type SkillSource =
  | { kind: "local" | "downloaded"; path: string }
  | { kind: "github"; repository: string; ref?: string };

type TargetPlan =
  | { kind: "openclaw"; target: "openclaw"; command?: string }
  | { kind: "portable"; target: string; command: string }
  | {
      kind: "xiaobaos";
      target: "xiaobaos";
      role: string;
      command?: string;
    };

type StarterCase = AgentE2ECaseV1;

type CaseReview = {
      kind: "external";
      caseId: string;
      agent: string;
      envAllowlist: string[];
      network: AgentE2ECaseV1["isolation"]["network"];
      isolation: AgentE2ECaseV1["isolation"]["level"];
      writableRoots: string[];
      timeoutMs: number;
    };

interface CasePlan {
  path: string;
  starter?: StarterCase;
  review: CaseReview;
}

class GuideCancelled extends Error {}

export async function startGuide(options: StartGuideOptions): Promise<CliExitCode> {
  const ownsIo = options.io === undefined;
  const io = options.io ?? readlineIO();
  let prepared = false;
  try {
    if (!io.interactive) {
      io.write("barena guide requires an interactive terminal. Use barena --help for automation commands.\n");
      return EXIT_ERROR;
    }

    const cwd = path.resolve(options.cwd ?? process.cwd());
    const subjectsRoot = path.resolve(cwd, options.subjectsRoot ?? "subjects");
    const runsRoot = path.resolve(cwd, options.runsRoot ?? "runs");

    io.write("\nBarena guided Skill evaluation\n");
    io.write("Compare the same task without the candidate Skill and with it.\n");
    io.write("Barena will verify artifacts, replay attempts, and produce a release decision.\n\n");
    io.write("It copies and scans Skill files, but never installs packages or runs repository install scripts.\n");
    io.write("Type q or quit at any prompt to cancel.\n\n");

    const source = await retryStep(io, "Skill source", () => askSkillSource(io, cwd));
    const subjectId = await askSubjectId(io, defaultSubjectId(source));
    const subjectRoot = path.join(subjectsRoot, subjectId);
    validateSnapshotBoundary(source, subjectRoot);
    const target = await retryStep(io, "Agent selection", () => askTarget(io, cwd));
    const casePlan = await retryStep(io, "Evaluation case", () => askCase(io, cwd, subjectId, target));
    const attempts = await askInteger(io, "How many attempts per arm?", 3, 1, 11);
    const argv = evaluationArgs(subjectRoot, casePlan.path, attempts, runsRoot, target);
    const sourceIsSnapshot = (source.kind === "local" || source.kind === "downloaded") &&
      path.resolve(source.path) === path.resolve(subjectRoot);
    const replacesSnapshot = fs.existsSync(subjectRoot) && !sourceIsSnapshot;

    io.write("\nEvaluation plan\n");
    io.write(`  Skill source: ${sourceSummary(source)}\n`);
    io.write(`  Imported snapshot: ${subjectRoot}\n`);
    if (replacesSnapshot) io.write("  Existing snapshot: replacement requires explicit confirmation\n");
    io.write(`  Agent: ${targetSummary(target, casePlan.review)}\n`);
    io.write(`  Baseline: same task with no candidate Skill\n`);
    io.write(`  Candidate: same task with ${subjectId}\n`);
    io.write(`  Case: ${casePlan.path}${casePlan.starter ? " (starter case will be created)" : ""}\n`);
    io.write(`  Attempts: ${attempts} baseline + ${attempts} candidate\n`);
    io.write("  Evidence: boundary/workspace/verifier (confidence capped at medium); native trace is linked only when the target genuinely emits it\n");
    writeCaseReview(io, target, casePlan, attempts);
    if (casePlan.starter) {
      io.write("  Starter warning: smoke/onboarding only; it does not prove production-quality Skill effectiveness.\n");
    }
    io.write("\nEquivalent automation command\n\n");
    io.write(`  barena ${argv.map(shellQuote).join(" ")}\n\n`);

    const preparePrompt = replacesSnapshot
      ? "Replace the existing snapshot and prepare this evaluation?"
      : "Prepare this evaluation?";
    if (!await askYesNo(io, preparePrompt, !replacesSnapshot)) {
      io.write("Nothing changed.\n");
      return EXIT_SUCCESS;
    }

    const importedPath = prepareSkill(source, subjectId, subjectsRoot, subjectRoot);
    if (casePlan.starter) {
      ensureDir(path.dirname(casePlan.path));
      if (fs.existsSync(casePlan.path)) throw new Error(`Starter case already exists: ${casePlan.path}`);
      writeJson(casePlan.path, casePlan.starter);
    }
    prepared = true;
    if (path.resolve(importedPath) !== path.resolve(subjectRoot)) {
      throw new Error(`Prepared Skill snapshot did not match the reviewed path: ${importedPath}`);
    }
    io.write(`Prepared Skill snapshot: ${importedPath}\n`);
    io.write(`Results will be written under: ${runsRoot}\n`);

    if (!await askYesNo(io, "Run the evaluation now? This may invoke a model or paid provider.", false)) {
      io.write("Prepared successfully. Run the command above when ready.\n");
      return EXIT_SUCCESS;
    }
    io.write("\nRunning evaluation...\n\n");
    return await options.execute(argv);
  } catch (error) {
    if (error instanceof GuideCancelled) {
      io.write(prepared
        ? "\nExecution cancelled. Prepared files were kept; run the reviewed command when ready.\n"
        : "\nCancelled. Nothing changed.\n");
      return EXIT_SUCCESS;
    }
    io.write(`\nGuide stopped: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_ERROR;
  } finally {
    if (ownsIo) io.close();
  }
}

function readlineIO(): GuideIO {
  const readline = createInterface({ input: stdin, output: stdout });
  return {
    interactive: Boolean(stdin.isTTY && stdout.isTTY),
    ask: (prompt) => readline.question(prompt),
    write: (message) => stdout.write(message),
    close: () => readline.close(),
  };
}

async function askSkillSource(io: GuideIO, cwd: string): Promise<SkillSource> {
  const choice = await choose(io, "Where is the Skill?", [
    "Local directory (recommended)",
    "GitHub repository",
    "Downloaded from SkillHub or another catalog",
  ], 1);
  if (choice === 2) {
    const repository = await askRequired(io, "GitHub owner/repo or URL: ");
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(repository) &&
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error("GitHub source must be https://github.com/owner/repo or owner/repo");
    }
    const ref = await askOptional(io, "Git ref/branch (blank for default): ");
    return { kind: "github", repository, ...(ref && { ref }) };
  }
  const label = choice === 3 ? "Downloaded Skill directory" : "Local Skill directory";
  const skillPath = resolveUserPath(await askRequired(io, `${label}: `), cwd);
  validateSkillDirectory(skillPath);
  return { kind: choice === 3 ? "downloaded" : "local", path: skillPath };
}

async function askSubjectId(io: GuideIO, suggested: string): Promise<string> {
  while (true) {
    const value = await askOptional(io, `Skill ID [${suggested}]: `) || suggested;
    if (/^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..") return value;
    io.write("  Skill ID may contain only letters, numbers, dot, underscore, and dash.\n");
  }
}

async function askTarget(io: GuideIO, cwd: string): Promise<TargetPlan> {
  const choice = await choose(io, "Which Agent should run the task?", [
    "OpenClaw (built-in adapter)",
    "XiaobaOS (ordinary chat target)",
    "Hermes or another CLI Agent (portable driver)",
  ], 1);
  if (choice === 2) {
    const role = await askRequired(io, "XiaobaOS Role ID used for both arms: ");
    const command = await askOptional(io, "XiaobaOS command/path [xiaoba]: ");
    return {
      kind: "xiaobaos",
      target: "xiaobaos",
      role,
      ...(command && command !== "xiaoba" && { command: resolveCommand(command, cwd) }),
    };
  }
  if (choice === 3) {
    const target = await askOptional(io, "Portable runtime ID [hermes]: ") || "hermes";
    if (!/^[A-Za-z0-9._-]+$/.test(target)) throw new Error("Portable runtime ID must be a safe identifier");
    const command = resolveCommand(await askRequired(io, "Portable driver command/path: "), cwd);
    return { kind: "portable", target, command };
  }
  const command = await askOptional(io, "OpenClaw command/path [openclaw]: ");
  return { kind: "openclaw", target: "openclaw", ...(command && command !== "openclaw" && { command: resolveCommand(command, cwd) }) };
}

async function askCase(
  io: GuideIO,
  cwd: string,
  subjectId: string,
  target: TargetPlan
): Promise<CasePlan> {
  const choice = await choose(io, "How will success be verified?", [
    "Use an existing Barena case (recommended for real evaluation)",
    "Create a starter smoke case (onboarding only)",
  ], 1);
  if (choice === 1) {
    const casePath = resolveUserPath(await askRequired(io, "Case JSON path: "), cwd);
    requiredFile(casePath, "Case");
    return { path: casePath, review: validatePreparedCase(casePath, target) };
  }
  const caseIdDefault = `${subjectId}-starter`;
  const caseId = await askOptional(io, `Case ID [${caseIdDefault}]: `) || caseIdDefault;
  if (!/^[A-Za-z0-9._-]+$/.test(caseId)) throw new Error("Case ID must be a safe identifier");
  const prompt = await askRequired(io, "Task prompt: ");
  const artifactPath = await askOptional(io, "Expected artifact path [result.txt]: ") || "result.txt";
  validateRelativePath(artifactPath, "Artifact path");
  const contains = await askRequired(io, "Text that must appear in the artifact: ");
  const defaultPath = path.join(cwd, "cases", `${caseId}.json`);
  const casePath = await askNewCasePath(io, cwd, defaultPath);
  if (target.kind === "xiaobaos") {
    const envAllowlist = commaList(await askOptional(io, "Allowed environment variable names (optional, comma separated): "));
    const network = await askNetworkPolicy(io, "allowlisted");
    const starter = xiaobaStarterCase(caseId, prompt, artifactPath, contains, target, envAllowlist, network);
    return { path: casePath, starter, review: externalCaseReview(starter) };
  }
  const settings = await askExternalStarterSettings(io, target);
  const starter = portableStarterCase(caseId, prompt, artifactPath, contains, target, settings);
  return { path: casePath, starter, review: externalCaseReview(starter) };
}

function xiaobaStarterCase(
  caseId: string,
  prompt: string,
  artifactPath: string,
  contains: string,
  target: Extract<TargetPlan, { kind: "xiaobaos" }>,
  envAllowlist: string[],
  network: AgentE2ECaseV1["isolation"]["network"]
): AgentE2ECaseV1 {
  return {
    schema: "barena.agent_e2e_case.v1",
    case_id: caseId,
    target: { adapter: "xiaoba", runtime: "xiaobaos", agent: target.role, env_allowlist: envAllowlist },
    task: { prompt },
    assertions: { artifacts: [{ path: artifactPath, exists: true, contains }] },
    replays: 1,
    timeout_ms: 180_000,
    isolation: { level: "policy_only", network, writable_roots: ["workspace"] },
  };
}

function portableStarterCase(
  caseId: string,
  prompt: string,
  artifactPath: string,
  contains: string,
  target: Exclude<TargetPlan, { kind: "xiaobaos" }>,
  settings: { agent?: string; envAllowlist: string[]; network: AgentE2ECaseV1["isolation"]["network"] }
): AgentE2ECaseV1 {
  return {
    schema: "barena.agent_e2e_case.v1",
    case_id: caseId,
    target: target.kind === "openclaw"
      ? { adapter: "openclaw", agent: settings.agent ?? "main", env_allowlist: settings.envAllowlist }
      : { adapter: "portable", runtime: target.target, ...(settings.agent && { agent: settings.agent }), env_allowlist: settings.envAllowlist },
    task: { prompt },
    assertions: { artifacts: [{ path: artifactPath, exists: true, contains }] },
    replays: 1,
    timeout_ms: 180_000,
    isolation: {
      level: "policy_only",
      network: settings.network,
      writable_roots: ["workspace"],
    },
  };
}

async function askNewCasePath(io: GuideIO, cwd: string, fallback: string): Promise<string> {
  while (true) {
    const value = await askOptional(io, `Write case to [${fallback}]: `) || fallback;
    const casePath = resolveUserPath(value, cwd);
    if (!fs.existsSync(casePath)) return casePath;
    io.write(`  Refusing to overwrite an existing case: ${casePath}\n`);
  }
}

async function askExternalStarterSettings(
  io: GuideIO,
  target: Exclude<TargetPlan, { kind: "xiaobaos" }>
): Promise<{ agent?: string; envAllowlist: string[]; network: AgentE2ECaseV1["isolation"]["network"] }> {
  const agent = target.kind === "openclaw"
    ? await askOptional(io, "OpenClaw agent ID [main]: ") || "main"
    : await askOptional(io, "Agent/profile ID (optional): ");
  const envAllowlist = commaList(
    await askOptional(
      io,
      target.kind === "openclaw"
        ? "Allowed environment variable names [OPENAI_API_KEY]: "
        : "Allowed environment variable names (optional, comma separated): "
    ),
    target.kind === "openclaw" ? ["OPENAI_API_KEY"] : []
  );
  const fallback = target.kind === "openclaw" ? "allowlisted" : "disabled";
  const network = await askNetworkPolicy(io, fallback);
  return { ...(agent && { agent }), envAllowlist, network };
}

async function askNetworkPolicy(
  io: GuideIO,
  fallback: AgentE2ECaseV1["isolation"]["network"]
): Promise<AgentE2ECaseV1["isolation"]["network"]> {
  while (true) {
    const value = (await askOptional(
      io,
      `Declared network policy [${fallback}] (disabled|allowlisted|unrestricted): `
    ) || fallback).toLowerCase();
    if (value === "disabled" || value === "allowlisted" || value === "unrestricted") return value;
    io.write("  Enter disabled, allowlisted, or unrestricted. This is a policy declaration, not a hard sandbox.\n");
  }
}

function prepareSkill(
  source: SkillSource,
  subjectId: string,
  subjectsRoot: string,
  subjectRoot: string
): string {
  if ((source.kind === "local" || source.kind === "downloaded") && path.resolve(source.path) === path.resolve(subjectRoot)) {
    validateSkillDirectory(source.path);
    return source.path;
  }
  const manifest = source.kind === "github"
    ? importGithubSkill(source.repository, { subjectId, subjectsRoot, ref: source.ref })
    : importLocalSkill(source.path, { subjectId, subjectsRoot });
  return manifest.paths.subject_root;
}

function validatePreparedCase(casePath: string, target: TargetPlan): CaseReview {
  if (target.kind === "xiaobaos") {
    const loaded = loadAgentE2ECase(casePath).caseDefinition;
    if (loaded.target.adapter !== "xiaoba" || loaded.target.runtime !== "xiaobaos") {
      throw new Error("XiaobaOS evaluation requires case target.adapter=xiaoba and target.runtime=xiaobaos");
    }
    if (loaded.target.agent !== target.role) {
      throw new Error(`XiaobaOS case target.agent must match the selected Role ${target.role}`);
    }
    return externalCaseReview(loaded);
  }
  const loaded = loadAgentE2ECase(casePath).caseDefinition;
  if (target.kind === "openclaw" && loaded.target.adapter !== "openclaw") {
    throw new Error("OpenClaw evaluation requires case target.adapter=openclaw");
  }
  if (target.kind === "portable" && (loaded.target.adapter !== "portable" || loaded.target.runtime !== target.target)) {
    throw new Error(`Portable evaluation requires case target.adapter=portable and target.runtime=${target.target}`);
  }
  return externalCaseReview(loaded);
}

function externalCaseReview(caseDefinition: AgentE2ECaseV1): CaseReview {
  return {
    kind: "external",
    caseId: caseDefinition.case_id,
    agent: caseDefinition.target.agent ?? (caseDefinition.target.adapter === "openclaw" ? "main" : "driver default"),
    envAllowlist: caseDefinition.target.env_allowlist ?? [],
    network: caseDefinition.isolation.network,
    isolation: caseDefinition.isolation.level,
    writableRoots: caseDefinition.isolation.writable_roots,
    timeoutMs: caseDefinition.timeout_ms ?? 180_000,
  };
}

function evaluationArgs(
  skillPath: string,
  casePath: string,
  attempts: number,
  runsRoot: string,
  target: TargetPlan
): string[] {
  const args = ["evaluate", "skill", skillPath, "--target", target.target, "--case", casePath, "--attempts", String(attempts), "--runs-root", runsRoot];
  if (target.kind === "xiaobaos") {
    args.push("--role", target.role);
    if (target.command) args.push("--xiaobaos-command", target.command);
  } else if (target.command) {
    args.push("--target-command", target.command);
  }
  return args;
}

async function choose(io: GuideIO, question: string, options: string[], recommended: number): Promise<number> {
  io.write(`${question}\n`);
  options.forEach((option, index) => io.write(`  ${index + 1}) ${option}${index + 1 === recommended ? " [recommended]" : ""}\n`));
  while (true) {
    const answer = await askOptional(io, `Select [${recommended}]: `);
    if (!answer) return recommended;
    const selected = Number(answer);
    if (Number.isInteger(selected) && selected >= 1 && selected <= options.length) return selected;
    io.write(`  Choose a number from 1 to ${options.length}.\n`);
  }
}

async function askRequired(io: GuideIO, prompt: string): Promise<string> {
  while (true) {
    const value = await askOptional(io, prompt);
    if (value) return value;
    io.write("  This answer is required.\n");
  }
}

async function askInteger(io: GuideIO, prompt: string, fallback: number, min: number, max: number): Promise<number> {
  while (true) {
    const answer = await askOptional(io, `${prompt} [${fallback}]: `);
    if (!answer) return fallback;
    const value = Number(answer);
    if (Number.isInteger(value) && value >= min && value <= max) return value;
    io.write(`  Enter an integer from ${min} to ${max}.\n`);
  }
}

async function askYesNo(io: GuideIO, prompt: string, fallback: boolean): Promise<boolean> {
  const marker = fallback ? "Y/n" : "y/N";
  while (true) {
    const value = (await askOptional(io, `${prompt} [${marker}]: `)).toLowerCase();
    if (!value) return fallback;
    if (["y", "yes"].includes(value)) return true;
    if (["n", "no"].includes(value)) return false;
    io.write("  Answer yes or no.\n");
  }
}

async function askOptional(io: GuideIO, prompt: string): Promise<string> {
  let answer: string;
  try {
    answer = await io.ask(prompt);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (error instanceof Error && (error.name === "AbortError" || code === "ERR_USE_AFTER_CLOSE")) {
      throw new GuideCancelled();
    }
    throw error;
  }
  const value = answer.trim();
  if (["q", "quit", ":q"].includes(value.toLowerCase())) throw new GuideCancelled();
  return value;
}

async function retryStep<T>(io: GuideIO, label: string, action: () => Promise<T>): Promise<T> {
  while (true) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof GuideCancelled) throw error;
      io.write(`  ${label} could not be accepted: ${error instanceof Error ? error.message : String(error)}\n`);
      io.write("  Try this step again, or type q to cancel.\n\n");
    }
  }
}

function validateSkillDirectory(skillPath: string): void {
  if (!fs.existsSync(skillPath) || !fs.lstatSync(skillPath).isDirectory() || fs.lstatSync(skillPath).isSymbolicLink()) {
    throw new Error(`Skill must be a real directory: ${skillPath}`);
  }
  requiredFile(path.join(skillPath, "SKILL.md"), "Skill manifest");
}

function validateSnapshotBoundary(source: SkillSource, subjectRoot: string): void {
  if (source.kind === "github") return;
  const sourcePath = path.resolve(source.path);
  const destinationPath = path.resolve(subjectRoot);
  if (sourcePath === destinationPath) return;
  if (isPathInside(sourcePath, destinationPath) || isPathInside(destinationPath, sourcePath)) {
    throw new Error(
      `Skill source and snapshot destination overlap (${sourcePath} / ${destinationPath}). ` +
      "Run the guide with --subjects-root pointing outside the Skill directory."
    );
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function requiredFile(value: string, label: string): void {
  if (!fs.existsSync(value) || !fs.lstatSync(value).isFile() || fs.lstatSync(value).isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${value}`);
  }
}

function validateRelativePath(value: string, label: string): void {
  const normalized = path.normalize(value);
  if (!value.trim() || path.isAbsolute(value) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} must stay inside the evaluation workspace`);
  }
}

function resolveUserPath(value: string, cwd: string): string {
  const expanded = value === "~" || value.startsWith(`~${path.sep}`)
    ? path.join(os.homedir(), value.slice(2))
    : value;
  return path.resolve(cwd, expanded);
}

function resolveCommand(value: string, cwd: string): string {
  return value.includes(path.sep) || value.startsWith(".") || value.startsWith("~")
    ? resolveUserPath(value, cwd)
    : value;
}

function commaList(value: string, fallback: string[] = []): string[] {
  if (!value.trim()) return fallback;
  const names = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new Error("Environment variable names must use letters, numbers, and underscore");
  }
  return names;
}

function defaultSubjectId(source: SkillSource): string {
  const raw = source.kind === "github"
    ? source.repository.replace(/\.git$/, "").split("/").filter(Boolean).pop() ?? "skill"
    : path.basename(source.path);
  return raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

function sourceSummary(source: SkillSource): string {
  return source.kind === "github"
    ? `${source.repository}${source.ref ? ` @ ${source.ref}` : ""}`
    : source.path;
}

function targetSummary(target: TargetPlan, review: CaseReview): string {
  if (target.kind === "xiaobaos") return `XiaobaOS ordinary chat adapter, Role ${target.role}`;
  const agent = review.agent;
  if (target.kind === "openclaw") return `OpenClaw built-in adapter, agent/profile ${agent}`;
  return `${target.target} portable driver (${target.command}), agent/profile ${agent}`;
}

function writeCaseReview(io: GuideIO, target: TargetPlan, casePlan: CasePlan, attempts: number): void {
  const review = casePlan.review;
  io.write(`  Case ID: ${review.caseId}\n`);
  io.write(`  Effective agent/profile: ${review.agent}\n`);
  io.write(`  Environment names passed: ${review.envAllowlist.length ? review.envAllowlist.join(", ") : "none"} (values are never printed)\n`);
  io.write(`  Network declaration: ${review.network}; isolation=${review.isolation} (policy declaration, not a hard sandbox)\n`);
  io.write(`  Writable roots: ${review.writableRoots.join(", ")}\n`);
  io.write(`  Timeout: ${formatDuration(review.timeoutMs)} per target session\n`);
  io.write(`  Maximum target sessions: ${attempts} per arm / ${attempts * 2} total; paired evaluation overrides case.replays\n`);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000}m`;
  if (milliseconds % 1_000 === 0) return `${milliseconds / 1_000}s`;
  return `${milliseconds}ms`;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}
