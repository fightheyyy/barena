import fs from "node:fs";
import path from "node:path";
import { importAgentTarget, listAgentTargets } from "../agents/targets";
import { runClearance } from "../domain/clearance";
import type { SubjectManifest } from "../domain/types";
import { loadAgentE2ECase, probeAgentE2E, runAgentE2ECase } from "../e2e/case-runner";
import { runSkillEvaluation } from "../evaluation/run-skill-evaluation";
import { loadXiaoBaLivePolicy, type LoadedXiaoBaLivePolicy } from "../evaluation/live-policy";
import {
  createXiaoBaNativeRoleRequest,
  createXiaoBaNativeRuntimeConfig,
  createXiaoBaNativeSkillRequest,
} from "../evaluation/xiaoba-native-input";
import { probeXiaoBaNativeRuntime, runXiaoBaNativeEvaluation } from "../evaluation/xiaoba-native-runner";
import { renderRunMarkdown } from "../reports/report";
import { listRunCatalog, loadRunRecord } from "../runs/catalog";
import { importGithubSkill } from "../subjects/github-importer";
import { importLocalSkill, loadSubjectManifest } from "../subjects/importer";
import { scanSubjectDirectory } from "../subjects/scanner";
import { OpenClawTargetAdapter } from "../targets/openclaw-target-adapter";
import { PortableTargetAdapter } from "../targets/portable-target-adapter";
import { startGuide } from "./guide";
import { startEvaluationTui } from "../tui/evaluation-tui";
import { startTui } from "../tui/tui";
import { readJson } from "../utils/fs";
import {
  EXIT_ERROR,
  EXIT_HELD,
  EXIT_SUCCESS,
  exitCodeForDecision,
  exitCodeForReadiness,
  exitCodeForScan,
  type CliExitCode,
} from "./exit-codes";

type FlagValue = string | boolean;

interface PackageMetadata {
  name?: string;
  version?: string;
  engines?: { node?: string };
}

const PACKAGE_JSON_PATH = path.resolve(__dirname, "..", "..", "package.json");
const BOOLEAN_FLAGS = new Set(["help", "version", "color", "no-color", "snapshot", "preflight-only"]);
const VALUE_FLAGS = new Set([
  "id",
  "subjects-root",
  "ref",
  "runs-root",
  "replays",
  "verifier",
  "target",
  "xiaobaos-command",
  "xiaoba-command",
  "target-command",
  "role",
  "case",
  "case-pack",
  "attempts",
  "baseline-role",
  "format",
  "xiaobaos-project-root",
  "xiaoba-project-root",
  "roles-root",
  "pass-env",
  "live-policy",
]);

export async function runCli(argv: string[]): Promise<CliExitCode> {
  try {
    const parsed = parseArgs(argv);
    const [command, subcommand, ...positionals] = parsed.positionals;
    if (parsed.flags.version || command === "version") {
      console.log(readPackageVersion());
      return EXIT_SUCCESS;
    }
    if (parsed.flags.help || command === "help") {
      printHelp();
      return EXIT_SUCCESS;
    }
    if (!command) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        return await startGuide({
          execute: runCli,
          subjectsRoot: stringFlag(parsed.flags["subjects-root"]) ?? undefined,
          runsRoot: stringFlag(parsed.flags["runs-root"]) ?? undefined,
        });
      } else {
        printHelp();
      }
      return EXIT_SUCCESS;
    }

    if (command === "guide") {
      return await startGuide({
        execute: runCli,
        subjectsRoot: stringFlag(parsed.flags["subjects-root"]) ?? undefined,
        runsRoot: stringFlag(parsed.flags["runs-root"]) ?? undefined,
      });
    }

    if (command === "import" && subcommand === "skill") {
      const source = required(positionals[0], "Usage: barena import skill <path> [--id subject-id]");
      printJson(importLocalSkill(source, {
        subjectId: stringFlag(parsed.flags.id) ?? undefined,
        subjectsRoot: stringFlag(parsed.flags["subjects-root"]) ?? "subjects",
      }));
      return EXIT_SUCCESS;
    }

    if (command === "import" && subcommand === "github") {
      const source = required(positionals[0], "Usage: barena import github <owner/repo|url> [--id subject-id] [--ref ref]");
      printJson(importGithubSkill(source, {
        subjectId: stringFlag(parsed.flags.id) ?? undefined,
        ref: stringFlag(parsed.flags.ref) ?? undefined,
        subjectsRoot: stringFlag(parsed.flags["subjects-root"]) ?? "subjects",
      }));
      return EXIT_SUCCESS;
    }

    if (command === "import" && (subcommand === "agent" || subcommand === "target")) {
      const targetId = required(positionals[0], "Usage: barena import agent <target-id> [--id subject-id]");
      printJson(importAgentTarget(targetId, {
        subjectId: stringFlag(parsed.flags.id) ?? undefined,
        subjectsRoot: stringFlag(parsed.flags["subjects-root"]) ?? "subjects",
      }));
      return EXIT_SUCCESS;
    }

    if (command === "scan") {
      const subjectId = required(subcommand, "Usage: barena scan <subject-id>");
      const manifest = loadSubjectManifest(subjectId, stringFlag(parsed.flags["subjects-root"]) ?? "subjects");
      const report = scanSubjectDirectory(subjectId, manifest.paths.subject_root, manifest.paths.scan_report);
      printJson(report);
      return exitCodeForScan(report.decision);
    }

    if (command === "run") {
      const subjectId = required(subcommand, "Usage: barena run <subject-id> [--replays 3] [--verifier path]");
      const manifest = loadSubjectManifest(subjectId, stringFlag(parsed.flags["subjects-root"]) ?? "subjects");
      const scorecard = runClearance(manifest, {
        runsRoot: stringFlag(parsed.flags["runs-root"]) ?? "runs",
        replays: numberFlag(parsed.flags.replays, 3),
        verifierPath: stringFlag(parsed.flags.verifier),
      });
      printJson(scorecard);
      return exitCodeForDecision(scorecard.decision);
    }

    if (command === "e2e" && subcommand === "probe") {
      const targetId = stringFlag(parsed.flags.target) ?? "openclaw";
      if (isXiaobaOSTarget(targetId)) {
        const native = createXiaoBaNativeRuntimeConfig(nativeInputFlags(parsed.flags));
        const result = await probeXiaoBaNativeRuntime(native.config);
        printJson(result);
        return exitCodeForReadiness(result.status);
      }
      const targetCommand = stringFlag(parsed.flags["target-command"]) ?? undefined;
      const targetAdapter = targetId === "openclaw"
        ? new OpenClawTargetAdapter({ command: targetCommand })
        : new PortableTargetAdapter({
            command: required(targetCommand, `--target-command <driver> is required for portable target ${targetId}`),
            runtime: safeTargetId(targetId),
          });
      const result = await probeAgentE2E({ targetAdapter });
      printJson(result);
      return result.ready === true ? EXIT_SUCCESS : EXIT_HELD;
    }

    if (command === "e2e" && subcommand === "run") {
      const casePath = required(positionals[0], "Usage: barena e2e run <case.json> [--runs-root runs]");
      const loaded = loadAgentE2ECase(casePath);
      const targetCommand = stringFlag(parsed.flags["target-command"]) ?? undefined;
      const targetAdapter = loaded.caseDefinition.target.adapter === "openclaw"
        ? new OpenClawTargetAdapter({
            command: targetCommand,
            envAllowlist: loaded.caseDefinition.target.env_allowlist,
          })
        : new PortableTargetAdapter({
            command: required(targetCommand, "--target-command <driver> is required for target.adapter=portable"),
            runtime: loaded.caseDefinition.target.runtime,
            envAllowlist: loaded.caseDefinition.target.env_allowlist,
          });
      const scorecard = await runAgentE2ECase(loaded.caseDefinition, loaded.caseBaseDir, {
        runsRoot: stringFlag(parsed.flags["runs-root"]) ?? "runs",
        targetAdapter,
      });
      printJson(scorecard);
      return exitCodeForDecision(scorecard.decision);
    }

    if (command === "evaluate" && subcommand === "skill") {
      const skillPath = required(positionals[0], "Usage: barena evaluate skill <skill-path> --case <case.json>|--case-pack <pack.json>");
      const casePath = stringFlag(parsed.flags.case) ?? undefined;
      const casePackPath = stringFlag(parsed.flags["case-pack"]) ?? undefined;
      const target = stringFlag(parsed.flags.target) ?? "openclaw";
      if (isXiaobaOSTarget(target)) {
        requireCaseSource(casePath, casePackPath);
        const roleId = required(stringFlag(parsed.flags.role) ?? undefined, "--role <xiaoba-role-id> is required for --target xiaobaos");
        const live = requiredLivePolicy(parsed.flags);
        const result = await runXiaoBaNativeEvaluation({
          request: createXiaoBaNativeSkillRequest({
            roleId,
            skillPath,
            ...(casePath && { casePaths: [casePath] }),
            ...(casePackPath && { casePackPath }),
            attemptsPerArm: numberFlag(parsed.flags.attempts, 2),
            ...nativeInputFlags(parsed.flags),
          }),
          runs_root: stringFlag(parsed.flags["runs-root"]) ?? "runs",
          accepted_scan_finding_ids: live.policy.accepted_scan_finding_ids,
          live_policy_binding: live,
          preflight_only: parsed.flags["preflight-only"] === true,
        });
        printJson(result);
        return exitCodeForDecision(result.decision);
      }
      if (casePackPath) throw new Error("--case-pack is supported only for --target xiaobaos");
      const externalTarget = safeTargetId(target);
      const externalCasePath = required(casePath, `--case <case.json> is required for --target ${externalTarget}`);
      const targetCommand = stringFlag(parsed.flags["target-command"]) ?? undefined;
      const targetAdapter = externalTarget === "openclaw"
        ? new OpenClawTargetAdapter({ command: targetCommand })
        : new PortableTargetAdapter({
            command: required(targetCommand, `--target-command <driver> is required for portable target ${externalTarget}`),
            runtime: externalTarget,
          });
      const result = await runSkillEvaluation({
        skillPath,
        targetId: externalTarget,
        cases: [externalCasePath],
        attemptsPerArm: numberFlag(parsed.flags.attempts, 2),
        runsRoot: stringFlag(parsed.flags["runs-root"]) ?? "runs",
        targetAdapter,
        acceptedScanFindingIds: acceptedScanFindingIds(parsed.flags),
      });
      printJson(result);
      return exitCodeForDecision(result.decision);
    }

    if (command === "evaluate" && subcommand === "role") {
      const candidateRoleId = required(positionals[0], "Usage: barena evaluate role <candidate-role-id> --baseline-role <role-id> --case <case.json>|--case-pack <pack.json>");
      const baselineRoleId = required(stringFlag(parsed.flags["baseline-role"]) ?? undefined, "--baseline-role <xiaoba-role-id> is required");
      const casePath = stringFlag(parsed.flags.case) ?? undefined;
      const casePackPath = stringFlag(parsed.flags["case-pack"]) ?? undefined;
      requireCaseSource(casePath, casePackPath);
      const target = stringFlag(parsed.flags.target) ?? "xiaobaos";
      if (!isXiaobaOSTarget(target)) throw new Error("Role evaluation currently supports only --target xiaobaos (xiaoba is a compatibility alias)");
      const live = requiredLivePolicy(parsed.flags);
      const result = await runXiaoBaNativeEvaluation({
        request: createXiaoBaNativeRoleRequest({
          baselineRoleId,
          candidateRoleId,
          ...(casePath && { casePaths: [casePath] }),
          ...(casePackPath && { casePackPath }),
          attemptsPerArm: numberFlag(parsed.flags.attempts, 2),
          ...nativeInputFlags(parsed.flags),
        }),
        runs_root: stringFlag(parsed.flags["runs-root"]) ?? "runs",
        accepted_scan_finding_ids: live.policy.accepted_scan_finding_ids,
        live_policy_binding: live,
        preflight_only: parsed.flags["preflight-only"] === true,
      });
      printJson(result);
      return exitCodeForDecision(result.decision);
    }

    if (command === "show" || command === "scorecard") {
      const runId = required(subcommand, `Usage: barena ${command} <run-id>`);
      printJson(loadRunRecord(runId, stringFlag(parsed.flags["runs-root"]) ?? "runs").result);
      return EXIT_SUCCESS;
    }

    if (command === "report") {
      const runId = required(subcommand, "Usage: barena report <run-id> [--format json|markdown]");
      const run = loadRunRecord(runId, stringFlag(parsed.flags["runs-root"]) ?? "runs");
      const format = stringFlag(parsed.flags.format) ?? "markdown";
      if (format === "json") printJson(run.result);
      else if (format === "markdown") console.log(renderRunMarkdown(run));
      else throw new Error("--format must be json or markdown");
      return EXIT_SUCCESS;
    }

    if (command === "list" && subcommand === "subjects") {
      printJson(listSubjects(stringFlag(parsed.flags["subjects-root"]) ?? "subjects"));
      return EXIT_SUCCESS;
    }

    if (command === "list" && subcommand === "runs") {
      printJson(listRunCatalog(stringFlag(parsed.flags["runs-root"]) ?? "runs"));
      return EXIT_SUCCESS;
    }

    if (command === "list" && (subcommand === "targets" || subcommand === "agents")) {
      printJson(listAgentTargets());
      return EXIT_SUCCESS;
    }

    if (command === "doctor") {
      const result = await doctor(nativeInputFlags(parsed.flags));
      printJson(result);
      return result.ok ? EXIT_SUCCESS : EXIT_HELD;
    }

    if (command === "tui") {
      const color = parsed.flags.color ? true : parsed.flags["no-color"] ? false : undefined;
      if (parsed.flags.snapshot) {
        startTui({
          subjectsRoot: stringFlag(parsed.flags["subjects-root"]) ?? "subjects",
          runsRoot: stringFlag(parsed.flags["runs-root"]) ?? "runs",
          snapshot: true,
          color,
        });
      } else {
        await startEvaluationTui({
          runsRoot: stringFlag(parsed.flags["runs-root"]) ?? "runs",
          color,
          xiaobaCommand: aliasedFlag(parsed.flags, "xiaobaos-command", "xiaoba-command") ?? undefined,
          xiaobaProjectRoot: aliasedFlag(parsed.flags, "xiaobaos-project-root", "xiaoba-project-root") ?? undefined,
          xiaobaRolesRoot: stringFlag(parsed.flags["roles-root"]) ?? undefined,
          livePolicyPath: stringFlag(parsed.flags["live-policy"]) ?? undefined,
          preflightOnly: parsed.flags["preflight-only"] === true,
        });
      }
      return EXIT_SUCCESS;
    }

    throw new Error(`Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`barena: ${message}`);
    return EXIT_ERROR;
  }
}

export function readPackageVersion(): string {
  const metadata = readPackageMetadata();
  if (typeof metadata.version !== "string" || !metadata.version) {
    throw new Error(`Barena package version is missing from ${PACKAGE_JSON_PATH}`);
  }
  return metadata.version;
}

export async function doctor(options: ReturnType<typeof nativeInputFlags> = {}): Promise<Record<string, unknown> & { ok: boolean }> {
  const packageMetadata = readPackageMetadata();
  const packageReady = packageMetadata.name === "barena" && typeof packageMetadata.version === "string";
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const nodeReady = Number.isInteger(nodeMajor) && nodeMajor >= minimumNodeMajor(packageMetadata.engines?.node);
  const native = createXiaoBaNativeRuntimeConfig(options);
  const xiaoba = await probeXiaoBaNativeRuntime(native.config);
  const ok = packageReady && nodeReady && xiaoba.status === "ready";

  return {
    ok,
    version: packageMetadata.version ?? "unknown",
    node: process.version,
    cwd: process.cwd(),
    package_json: fs.existsSync(PACKAGE_JSON_PATH),
    package: {
      status: packageReady ? "ready" : "blocked",
      name: packageMetadata.name ?? "unknown",
      version: packageMetadata.version ?? "unknown",
      package_json: PACKAGE_JSON_PATH,
    },
    runtime: {
      status: nodeReady ? "ready" : "blocked",
      node: process.version,
      required: packageMetadata.engines?.node ?? "not recorded",
      platform: process.platform,
      architecture: process.arch,
    },
    xiaoba,
    git_available: commandExists("git"),
  };
}

function readPackageMetadata(): PackageMetadata {
  if (!fs.existsSync(PACKAGE_JSON_PATH)) throw new Error(`Barena package metadata not found: ${PACKAGE_JSON_PATH}`);
  const metadata = readJson<PackageMetadata>(PACKAGE_JSON_PATH);
  if (!metadata || typeof metadata !== "object") throw new Error(`Invalid Barena package metadata: ${PACKAGE_JSON_PATH}`);
  return metadata;
}

function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, FlagValue> } {
  const positionals: string[] = [];
  const flags: Record<string, FlagValue> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--version" || arg === "-v") flags.version = true;
    else if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
        continue;
      }
      if (!VALUE_FLAGS.has(name)) throw new Error(`Unknown flag: --${name}`);
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`--${name} requires a value`);
      flags[name] = next;
      index += 1;
    } else positionals.push(arg);
  }
  return { positionals, flags };
}

function required(value: string | undefined, usage: string): string {
  if (!value || value.startsWith("--")) throw new Error(usage);
  return value;
}

function requireCaseSource(casePath: string | undefined, casePackPath: string | undefined): void {
  if (casePath && casePackPath) throw new Error("Use either --case or --case-pack, not both");
  if (!casePath && !casePackPath) throw new Error("One of --case <case.json> or --case-pack <pack.json> is required");
}

function stringFlag(value: FlagValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function aliasedFlag(
  flags: Record<string, FlagValue>,
  canonical: string,
  legacy: string
): string | null {
  const canonicalValue = stringFlag(flags[canonical]);
  const legacyValue = stringFlag(flags[legacy]);
  if (canonicalValue && legacyValue && canonicalValue !== legacyValue) {
    throw new Error(`--${canonical} and --${legacy} must not conflict`);
  }
  return canonicalValue ?? legacyValue;
}

function isXiaobaOSTarget(value: string): boolean {
  return value === "xiaobaos" || value === "xiaoba";
}

function safeTargetId(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error("--target must be a safe runtime identifier");
  return value;
}

function numberFlag(value: FlagValue | undefined, fallback: number): number {
  if (value === undefined || value === false) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected non-negative integer flag value, got ${String(value)}`);
  }
  return parsed;
}

function requiredLivePolicy(flags: Record<string, FlagValue>): LoadedXiaoBaLivePolicy {
  const policyValue = stringFlag(flags["live-policy"]);
  if (!policyValue) {
    throw new Error("XiaobaOS live evaluation requires --live-policy <policy.json>; use --preflight-only to stop before provider execution.");
  }
  return loadXiaoBaLivePolicy(policyValue);
}

function acceptedScanFindingIds(flags: Record<string, FlagValue>): string[] {
  const policyValue = stringFlag(flags["live-policy"]);
  if (!policyValue) return [];
  const policyPath = path.resolve(policyValue);
  const policy = readJson<Record<string, unknown>>(policyPath);
  const accepted = policy.accepted_scan_finding_ids;
  if (accepted === undefined) return [];
  if (!Array.isArray(accepted) || !accepted.every((value) => typeof value === "string" && value.length > 0)) {
    throw new Error(`live policy accepted_scan_finding_ids must be a string array: ${policyPath}`);
  }
  return [...new Set(accepted)];
}

function nativeInputFlags(flags: Record<string, FlagValue>): {
  binaryPath?: string;
  projectRoot?: string;
  rolesRoot?: string;
  passEnv?: string[];
} {
  const passEnv = stringFlag(flags["pass-env"]);
  return {
    binaryPath: aliasedFlag(flags, "xiaobaos-command", "xiaoba-command") ?? undefined,
    projectRoot: aliasedFlag(flags, "xiaobaos-project-root", "xiaoba-project-root") ?? undefined,
    rolesRoot: stringFlag(flags["roles-root"]) ?? undefined,
    passEnv: passEnv ? passEnv.split(",").map((item) => item.trim()).filter(Boolean) : undefined,
  };
}

function listSubjects(subjectsRoot: string): SubjectManifest[] {
  const root = path.resolve(subjectsRoot);
  if (!fs.existsSync(root)) return [];
  if (!fs.statSync(root).isDirectory()) throw new Error(`Subjects root is not a directory: ${root}`);
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => path.join(root, entry.name, "subject-manifest.json"))
    .filter((manifestPath) => fs.existsSync(manifestPath))
    .map((manifestPath) => readJson<SubjectManifest>(manifestPath));
}

function commandExists(command: string): boolean {
  for (const entry of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return true;
    } catch {
      // Continue searching PATH.
    }
  }
  return false;
}

function minimumNodeMajor(engine: string | undefined): number {
  const match = engine?.match(/>=\s*(\d+)/);
  return match ? Number(match[1]) : 18;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
  console.log(`Barena - End-to-end testing and release CI for open-source AI agents

Start here:
  barena                              # guided Skill evaluation
  barena guide [--subjects-root path] [--runs-root path]

Evaluate a change:
  barena evaluate skill <path> --target xiaobaos --role <role-id> (--case <native-case.json> | --case-pack <pack.json>) --live-policy <policy.json> [--preflight-only]
  barena evaluate role <candidate-role-id> --baseline-role <role-id> (--case <native-case.json> | --case-pack <pack.json>) --live-policy <policy.json> [--preflight-only]
  barena evaluate skill <path> --target openclaw --case <agent-case.json> [--attempts 2]
  barena evaluate skill <path> --target hermes --target-command ./driver --case <portable-case.json> [--attempts 2]

Import a Skill:
  barena import skill <path> [--id subject-id] [--subjects-root subjects]
  barena import github <owner/repo|url> [--id subject-id] [--ref ref]

Inspect results:
  barena list runs
  barena show <run-id>
  barena report <run-id> [--format markdown|json]

Advanced:
  barena import agent <opencode|xiaoba|hermes|openclaw> [--id subject-id]
  barena scan <subject-id>
  barena run <subject-id> [--replays 3] [--verifier path]
  barena e2e probe [--target xiaobaos|openclaw|hermes] [--target-command ./driver]
  barena e2e run <case.json> [--target-command ./driver] [--runs-root runs]
  barena list subjects
  barena list targets
  barena tui [--snapshot] [--color|--no-color]  # advanced evidence TUI
  barena doctor

Exit codes:
  0  cleared / ready / successful read
  1  held / blocked
  2  rejected / unsafe
  3  usage / configuration / schema / I/O / internal error
`);
}
