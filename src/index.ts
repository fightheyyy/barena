#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { importAgentTarget, listAgentTargets } from "./agents/targets";
import { runClearance } from "./domain/clearance";
import { Scorecard, StaticScanReport, SubjectManifest } from "./domain/types";
import { loadAgentE2ECase, probeAgentE2E, runAgentE2ECase } from "./e2e/case-runner";
import { XiaoBaEvaluatorRuntime } from "./evaluators/xiaoba-evaluator-runtime";
import { runSkillEvaluation } from "./evaluation/run-skill-evaluation";
import {
  createXiaoBaNativeRoleRequest,
  createXiaoBaNativeRuntimeConfig,
  createXiaoBaNativeSkillRequest,
} from "./evaluation/xiaoba-native-input";
import { probeXiaoBaNativeRuntime, runXiaoBaNativeEvaluation } from "./evaluation/xiaoba-native-runner";
import { renderMarkdown } from "./reports/report";
import { importGithubSkill } from "./subjects/github-importer";
import { importLocalSkill, loadSubjectManifest } from "./subjects/importer";
import { scanSubjectDirectory } from "./subjects/scanner";
import { startTui } from "./tui/tui";
import { startEvaluationTui } from "./tui/evaluation-tui";
import { OpenClawTargetAdapter } from "./targets/openclaw-target-adapter";
import { readJson } from "./utils/fs";

type FlagValue = string | boolean;

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  const [command, subcommand, ...positionals] = parsed.positionals;

  try {
    if (parsed.flags.version || command === "version") {
      console.log(readVersion());
      return;
    }
    if (parsed.flags.help || command === "help") {
      printHelp();
      return;
    }
    if (!command) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        await startEvaluationTui({ runsRoot: stringFlag(parsed.flags["runs-root"]) ?? "runs" });
      } else {
        printHelp();
      }
      return;
    }

    if (command === "import" && subcommand === "skill") {
      const source = required(positionals[0], "Usage: barena import skill <path> [--id subject-id]");
      const manifest = importLocalSkill(source, {
        subjectId: stringFlag(parsed.flags.id) ?? undefined,
        subjectsRoot: stringFlag(parsed.flags["subjects-root"]) ?? "subjects",
      });
      printJson(manifest);
      return;
    }

    if (command === "import" && subcommand === "github") {
      const source = required(positionals[0], "Usage: barena import github <owner/repo|url> [--id subject-id] [--ref ref]");
      const manifest = importGithubSkill(source, {
        subjectId: stringFlag(parsed.flags.id) ?? undefined,
        ref: stringFlag(parsed.flags.ref) ?? undefined,
        subjectsRoot: stringFlag(parsed.flags["subjects-root"]) ?? "subjects",
      });
      printJson(manifest);
      return;
    }

    if (command === "import" && (subcommand === "agent" || subcommand === "target")) {
      const targetId = required(positionals[0], "Usage: barena import agent <target-id> [--id subject-id]");
      const manifest = importAgentTarget(targetId, {
        subjectId: stringFlag(parsed.flags.id) ?? undefined,
        subjectsRoot: stringFlag(parsed.flags["subjects-root"]) ?? "subjects",
      });
      printJson(manifest);
      return;
    }

    if (command === "scan") {
      const subjectId = required(subcommand, "Usage: barena scan <subject-id>");
      const manifest = loadSubjectManifest(subjectId, stringFlag(parsed.flags["subjects-root"]) ?? "subjects");
      const report = scanSubjectDirectory(subjectId, manifest.paths.subject_root, manifest.paths.scan_report);
      printJson(report);
      return;
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
      return;
    }

    if (command === "e2e" && subcommand === "probe") {
      const targetId = stringFlag(parsed.flags.target) ?? "openclaw";
      if (targetId === "xiaoba") {
        const native = createXiaoBaNativeRuntimeConfig(nativeInputFlags(parsed.flags));
        printJson(await probeXiaoBaNativeRuntime(native.config));
        return;
      }
      if (targetId !== "openclaw") {
        throw new Error("--target must be xiaoba or openclaw");
      }
      const result = await probeAgentE2E({
        evaluator: new XiaoBaEvaluatorRuntime({ command: stringFlag(parsed.flags["xiaoba-command"]) ?? undefined }),
        targetAdapter: new OpenClawTargetAdapter({ command: stringFlag(parsed.flags["target-command"]) ?? undefined }),
      });
      printJson(result);
      return;
    }

    if (command === "e2e" && subcommand === "run") {
      const casePath = required(positionals[0], "Usage: barena e2e run <case.json> [--runs-root runs]");
      const loaded = loadAgentE2ECase(casePath);
      const scorecard = await runAgentE2ECase(loaded.caseDefinition, loaded.caseBaseDir, {
        runsRoot: stringFlag(parsed.flags["runs-root"]) ?? "runs",
        evaluator: new XiaoBaEvaluatorRuntime({ command: stringFlag(parsed.flags["xiaoba-command"]) ?? undefined }),
        targetAdapter: new OpenClawTargetAdapter({
          command: stringFlag(parsed.flags["target-command"]) ?? undefined,
          envAllowlist: loaded.caseDefinition.target.env_allowlist,
        }),
      });
      printJson(scorecard);
      return;
    }

    if (command === "evaluate" && subcommand === "skill") {
      const skillPath = required(positionals[0], "Usage: barena evaluate skill <skill-path> --case <case.json>");
      const casePath = required(stringFlag(parsed.flags.case) ?? undefined, "--case <case.json> is required");
      const target = stringFlag(parsed.flags.target) ?? "openclaw";
      if (target === "xiaoba") {
        const roleId = required(stringFlag(parsed.flags.role) ?? undefined, "--role <xiaoba-role-id> is required for --target xiaoba");
        const request = createXiaoBaNativeSkillRequest({
          roleId,
          skillPath,
          casePaths: [casePath],
          attemptsPerArm: numberFlag(parsed.flags.attempts, 2),
          ...nativeInputFlags(parsed.flags),
        });
        printJson(await runXiaoBaNativeEvaluation({
          request,
          runs_root: stringFlag(parsed.flags["runs-root"]) ?? "runs",
        }));
        return;
      }
      if (target !== "openclaw") throw new Error("--target must be xiaoba or openclaw");
      const result = await runSkillEvaluation({
        skillPath,
        cases: [casePath],
        attemptsPerArm: numberFlag(parsed.flags.attempts, 2),
        runsRoot: stringFlag(parsed.flags["runs-root"]) ?? "runs",
        evaluator: new XiaoBaEvaluatorRuntime({ command: stringFlag(parsed.flags["xiaoba-command"]) ?? undefined }),
        targetAdapter: new OpenClawTargetAdapter({ command: stringFlag(parsed.flags["target-command"]) ?? undefined }),
      });
      printJson(result);
      return;
    }

    if (command === "evaluate" && subcommand === "role") {
      const candidateRoleId = required(positionals[0], "Usage: barena evaluate role <candidate-role-id> --baseline-role <role-id> --case <case.json>");
      const baselineRoleId = required(stringFlag(parsed.flags["baseline-role"]) ?? undefined, "--baseline-role <xiaoba-role-id> is required");
      const casePath = required(stringFlag(parsed.flags.case) ?? undefined, "--case <case.json> is required");
      const target = stringFlag(parsed.flags.target) ?? "xiaoba";
      if (target !== "xiaoba") throw new Error("Role evaluation currently supports only --target xiaoba");
      const request = createXiaoBaNativeRoleRequest({
        baselineRoleId,
        candidateRoleId,
        casePaths: [casePath],
        attemptsPerArm: numberFlag(parsed.flags.attempts, 2),
        ...nativeInputFlags(parsed.flags),
      });
      printJson(await runXiaoBaNativeEvaluation({
        request,
        runs_root: stringFlag(parsed.flags["runs-root"]) ?? "runs",
      }));
      return;
    }

    if (command === "scorecard") {
      const runId = required(subcommand, "Usage: barena scorecard <run-id>");
      const scorecard = loadScorecard(runId, stringFlag(parsed.flags["runs-root"]) ?? "runs");
      printJson(scorecard);
      return;
    }

    if (command === "report") {
      const runId = required(subcommand, "Usage: barena report <run-id> [--format json|markdown]");
      const scorecard = loadScorecard(runId, stringFlag(parsed.flags["runs-root"]) ?? "runs");
      const format = stringFlag(parsed.flags.format) ?? "markdown";
      if (format === "json") {
        printJson(scorecard);
      } else if (format === "markdown") {
        console.log(renderMarkdown(scorecard));
      } else {
        throw new Error("--format must be json or markdown");
      }
      return;
    }

    if (command === "list" && subcommand === "subjects") {
      printJson(listSubjects(stringFlag(parsed.flags["subjects-root"]) ?? "subjects"));
      return;
    }

    if (command === "list" && subcommand === "runs") {
      printJson(listRuns(stringFlag(parsed.flags["runs-root"]) ?? "runs"));
      return;
    }

    if (command === "list" && (subcommand === "targets" || subcommand === "agents")) {
      printJson(listAgentTargets());
      return;
    }

    if (command === "doctor") {
      printJson(doctor());
      return;
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
          xiaobaCommand: stringFlag(parsed.flags["xiaoba-command"]) ?? undefined,
          xiaobaProjectRoot: stringFlag(parsed.flags["xiaoba-project-root"]) ?? undefined,
          xiaobaRolesRoot: stringFlag(parsed.flags["roles-root"]) ?? undefined,
        });
      }
      return;
    }

    throw new Error(`Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`barena: ${message}`);
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, FlagValue> } {
  const positionals: string[] = [];
  const flags: Record<string, FlagValue> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--version" || arg === "-v") {
      flags.version = true;
    } else if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        flags[name] = true;
      } else {
        flags[name] = next;
        index += 1;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function required(value: string | undefined, usage: string): string {
  if (!value || value.startsWith("--")) {
    throw new Error(usage);
  }
  return value;
}

function stringFlag(value: FlagValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function numberFlag(value: FlagValue | undefined, fallback: number): number {
  if (value === undefined || value === false) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected non-negative integer flag value, got ${String(value)}`);
  }
  return parsed;
}

function nativeInputFlags(flags: Record<string, FlagValue>): {
  binaryPath?: string;
  projectRoot?: string;
  rolesRoot?: string;
  passEnv?: string[];
} {
  const passEnv = stringFlag(flags["pass-env"]);
  return {
    binaryPath: stringFlag(flags["xiaoba-command"]) ?? undefined,
    projectRoot: stringFlag(flags["xiaoba-project-root"]) ?? undefined,
    rolesRoot: stringFlag(flags["roles-root"]) ?? undefined,
    passEnv: passEnv ? passEnv.split(",").map((item) => item.trim()).filter(Boolean) : undefined,
  };
}

function loadScorecard(runId: string, runsRoot: string): Scorecard {
  return readJson<Scorecard>(path.resolve(runsRoot, runId, "reviewer", "scorecard.json"));
}

function listSubjects(subjectsRoot: string): SubjectManifest[] {
  const root = path.resolve(subjectsRoot);
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => path.join(root, entry.name, "subject-manifest.json"))
    .filter((manifestPath) => fs.existsSync(manifestPath))
    .map((manifestPath) => readJson<SubjectManifest>(manifestPath));
}

function listRuns(runsRoot: string): Array<{ run_id: string; scorecard?: Scorecard }> {
  const root = path.resolve(runsRoot);
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const scorecardPath = path.join(root, entry.name, "reviewer", "scorecard.json");
      return {
        run_id: entry.name,
        scorecard: fs.existsSync(scorecardPath) ? readJson<Scorecard>(scorecardPath) : undefined,
      };
    });
}

function doctor(): Record<string, unknown> {
  return {
    ok: true,
    version: readVersion(),
    node: process.version,
    cwd: process.cwd(),
    package_json: fs.existsSync(path.resolve("package.json")),
    git_available: commandExists("git"),
  };
}

function commandExists(command: string): boolean {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
  return pathEntries.some((entry) => fs.existsSync(path.join(entry, command)));
}

function readVersion(): string {
  const packagePath = path.resolve("package.json");
  if (!fs.existsSync(packagePath)) {
    return "0.1.0";
  }
  return readJson<{ version: string }>(packagePath).version;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
  console.log(`Barena - End-to-end testing and release CI for open-source AI agents

Usage:
  barena                              # interactive XiaoBa-first capability release TUI
  barena evaluate skill <path> --target xiaoba --role <role-id> --case <native-case.json> [--attempts 2]
  barena evaluate role <candidate-role-id> --baseline-role <role-id> --case <native-case.json> [--attempts 2]
  barena evaluate skill <path> --target openclaw --case <agent-case.json> [--attempts 2]
  barena import skill <path> [--id subject-id] [--subjects-root subjects]
  barena import github <owner/repo|url> [--id subject-id] [--ref ref]
  barena import agent <opencode|xiaoba|hermes|openclaw> [--id subject-id]
  barena scan <subject-id>
  barena run <subject-id> [--replays 3] [--verifier path]
  barena e2e probe [--target xiaoba|openclaw]
  barena e2e run <case.json> [--runs-root runs]
  barena scorecard <run-id>
  barena report <run-id> [--format markdown|json]
  barena list subjects
  barena list runs
  barena list targets
  barena tui [--snapshot] [--color|--no-color]
  barena doctor

MVP1 runtime:
  provider: barena-deterministic
  adapter: xiaoba-compatible
  xiaoba invoked: false

XiaoBa native release runtime:
  Skill comparison: same explicit Role without vs with candidate Skill
  Role comparison: explicit baseline Role vs candidate Role
  evidence: native session trace + Arena stages + Barena artifact verifier
  evaluator stages: XiaoBa-owned composite stages, not three independent AgentSessions

OpenClaw external release runtime:
  comparison: no-Skill baseline vs selected candidate Skill
  outcome truth: artifact verifier evidence
  effectiveness: observed candidate lift over baseline
  stability: repeated isolated attempts

Agent E2E runtime:
  evaluator: xiaoba-cli (required, fail closed)
  first native target: xiaoba-cli native Arena
  second external target: openclaw local JSON CLI
  isolation: policy_only
`);
}

void main(process.argv.slice(2));
