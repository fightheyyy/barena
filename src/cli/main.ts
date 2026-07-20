import fs from "node:fs";
import path from "node:path";
import { importAgentTarget, listAgentTargets } from "../agents/targets";
import { runClearance } from "../domain/clearance";
import type { SubjectManifest } from "../domain/types";
import { loadAgentE2ECase, probeAgentE2E, runAgentE2ECase } from "../e2e/case-runner";
import { runSkillEvaluation } from "../evaluation/run-skill-evaluation";
import { listBuiltinSuites, resolveBuiltinSuite } from "../evaluation/builtin-suites";
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
import {
  initializeProjectConfig,
  loadProjectConfig,
  providerReadiness,
  resolveConfigReference,
  type BarenaTargetProfile,
  type LoadedProjectConfig,
} from "./project-config";
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
const BOOLEAN_FLAGS = new Set(["help", "version", "color", "no-color", "snapshot", "preflight-only", "force"]);
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
  "config",
  "provider",
  "model",
  "api-key-env",
  "api-base-env",
  "agent",
  "suite",
]);

export async function runCli(argv: string[]): Promise<CliExitCode> {
  try {
    const parsed = parseArgs(argv);
    const [command, subcommand, ...positionals] = parsed.positionals;
    const effectiveCommand = command === "eval" ? "evaluate" : command;
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

    if (effectiveCommand === "init") {
      const passEnv = stringFlag(parsed.flags["pass-env"]);
      const result = initializeProjectConfig({
        configPath: stringFlag(parsed.flags.config) ?? undefined,
        target: stringFlag(parsed.flags.target) ?? undefined,
        targetCommand: stringFlag(parsed.flags["target-command"]) ?? aliasedFlag(parsed.flags, "xiaobaos-command", "xiaoba-command") ?? undefined,
        agent: stringFlag(parsed.flags.agent) ?? undefined,
        role: stringFlag(parsed.flags.role) ?? undefined,
        livePolicy: stringFlag(parsed.flags["live-policy"]) ?? undefined,
        envAllowlist: passEnv ? passEnv.split(",").map((value) => value.trim()).filter(Boolean) : undefined,
        provider: stringFlag(parsed.flags.provider) ?? undefined,
        model: stringFlag(parsed.flags.model) ?? undefined,
        credentialEnv: stringFlag(parsed.flags["api-key-env"]) ?? undefined,
        apiBaseEnv: stringFlag(parsed.flags["api-base-env"]) ?? undefined,
        suite: stringFlag(parsed.flags.suite) ?? undefined,
        attempts: parsed.flags.attempts === undefined ? undefined : numberFlag(parsed.flags.attempts, 3),
        subjectsRoot: stringFlag(parsed.flags["subjects-root"]) ?? undefined,
        runsRoot: stringFlag(parsed.flags["runs-root"]) ?? undefined,
        force: parsed.flags.force === true,
      });
      printJson(result);
      return EXIT_SUCCESS;
    }

    if (effectiveCommand === "config" && subcommand === "show") {
      const loaded = requiredProjectConfig(parsed.flags);
      printJson({ config_path: loaded.path, project_root: loaded.root, config: loaded.config });
      return EXIT_SUCCESS;
    }

    if (effectiveCommand === "config" && subcommand === "path") {
      const loaded = requiredProjectConfig(parsed.flags);
      console.log(loaded.path);
      return EXIT_SUCCESS;
    }

    if (effectiveCommand === "guide") {
      return await startGuide({
        execute: runCli,
        subjectsRoot: stringFlag(parsed.flags["subjects-root"]) ?? undefined,
        runsRoot: stringFlag(parsed.flags["runs-root"]) ?? undefined,
      });
    }

    if (effectiveCommand === "import" && subcommand === "skill") {
      const source = required(positionals[0], "Usage: barena import skill <path> [--id subject-id]");
      printJson(importLocalSkill(source, {
        subjectId: stringFlag(parsed.flags.id) ?? undefined,
        subjectsRoot: stringFlag(parsed.flags["subjects-root"]) ?? "subjects",
      }));
      return EXIT_SUCCESS;
    }

    if (effectiveCommand === "import" && subcommand === "github") {
      const source = required(positionals[0], "Usage: barena import github <owner/repo|url> [--id subject-id] [--ref ref]");
      printJson(importGithubSkill(source, {
        subjectId: stringFlag(parsed.flags.id) ?? undefined,
        ref: stringFlag(parsed.flags.ref) ?? undefined,
        subjectsRoot: stringFlag(parsed.flags["subjects-root"]) ?? "subjects",
      }));
      return EXIT_SUCCESS;
    }

    if (effectiveCommand === "import" && (subcommand === "agent" || subcommand === "target")) {
      const targetId = required(positionals[0], "Usage: barena import agent <target-id> [--id subject-id]");
      printJson(importAgentTarget(targetId, {
        subjectId: stringFlag(parsed.flags.id) ?? undefined,
        subjectsRoot: stringFlag(parsed.flags["subjects-root"]) ?? "subjects",
      }));
      return EXIT_SUCCESS;
    }

    if (effectiveCommand === "scan") {
      const subjectId = required(subcommand, "Usage: barena scan <subject-id>");
      const manifest = loadSubjectManifest(subjectId, stringFlag(parsed.flags["subjects-root"]) ?? "subjects");
      const report = scanSubjectDirectory(subjectId, manifest.paths.subject_root, manifest.paths.scan_report);
      printJson(report);
      return exitCodeForScan(report.decision);
    }

    if (effectiveCommand === "run") {
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

    if (effectiveCommand === "e2e" && subcommand === "probe") {
      const project = optionalProjectConfig(parsed.flags);
      const targetId = stringFlag(parsed.flags.target) ?? project?.config.default_target ?? "openclaw";
      const profile = configuredProfile(project, targetId);
      if (isXiaobaOSTarget(targetId)) {
        const native = createXiaoBaNativeRuntimeConfig(nativeInputFlags(parsed.flags, project, profile));
        const result = await probeXiaoBaNativeRuntime(native.config);
        printJson(result);
        return exitCodeForReadiness(result.status);
      }
      const targetCommand = stringFlag(parsed.flags["target-command"]) ?? profileCommand(project, profile) ?? undefined;
      const envAllowlist = profile?.env_allowlist ?? [];
      const targetAdapter = targetId === "openclaw"
        ? new OpenClawTargetAdapter({ command: targetCommand, envAllowlist })
        : new PortableTargetAdapter({
            command: required(targetCommand, `--target-command <driver> is required for portable target ${targetId}`),
            runtime: safeTargetId(targetId),
            envAllowlist,
          });
      const result = await probeAgentE2E({ targetAdapter });
      printJson(result);
      return result.ready === true ? EXIT_SUCCESS : EXIT_HELD;
    }

    if (effectiveCommand === "e2e" && subcommand === "run") {
      const casePath = required(positionals[0], "Usage: barena e2e run <case.json> [--runs-root runs]");
      const loaded = loadAgentE2ECase(casePath);
      const project = optionalProjectConfig(parsed.flags);
      const caseTargetId = loaded.caseDefinition.target.adapter === "openclaw"
        ? "openclaw"
        : loaded.caseDefinition.target.runtime;
      const profile = caseTargetId ? configuredProfile(project, caseTargetId) : undefined;
      const targetCommand = stringFlag(parsed.flags["target-command"]) ?? profileCommand(project, profile) ?? undefined;
      const envAllowlist = [...new Set([...(profile?.env_allowlist ?? []), ...(loaded.caseDefinition.target.env_allowlist ?? [])])];
      const targetAdapter = loaded.caseDefinition.target.adapter === "openclaw"
        ? new OpenClawTargetAdapter({
            command: targetCommand,
            envAllowlist,
          })
        : new PortableTargetAdapter({
            command: required(targetCommand, "--target-command <driver> is required for target.adapter=portable"),
            runtime: loaded.caseDefinition.target.runtime,
            envAllowlist,
          });
      const scorecard = await runAgentE2ECase(loaded.caseDefinition, loaded.caseBaseDir, {
        runsRoot: resolvedRoot(parsed.flags, project, "runs"),
        targetAdapter,
      });
      printJson(scorecard);
      return exitCodeForDecision(scorecard.decision);
    }

    if (effectiveCommand === "evaluate" && subcommand === "skill") {
      const project = optionalProjectConfig(parsed.flags);
      const skillPath = required(positionals[0], "Usage: barena eval skill <skill-path> [--suite skillsbench:starter|--case <case.json>|--case-pack <pack.json>]");
      let casePath = stringFlag(parsed.flags.case) ?? undefined;
      let casePackPath = stringFlag(parsed.flags["case-pack"]) ?? undefined;
      const target = stringFlag(parsed.flags.target) ?? project?.config.default_target ?? "openclaw";
      const profile = configuredProfile(project, target);
      const suiteName = stringFlag(parsed.flags.suite) ?? (!casePath && !casePackPath ? project?.config.defaults.suite : undefined);
      let externalCases: string[] | undefined;
      if (suiteName) {
        if (casePath || casePackPath) throw new Error("Use --suite, --case, or --case-pack; do not combine them");
        const suite = resolveBuiltinSuite({
          suite: suiteName,
          targetId: target,
          outputRoot: path.join(project?.root ?? process.cwd(), ".barena", "generated"),
          agent: profile?.kind === "openclaw" || profile?.kind === "portable" ? profile.agent : undefined,
          model: project?.config.provider?.model,
          envAllowlist: profile?.env_allowlist,
        });
        if (suite.kind === "xiaoba_case_pack") casePackPath = suite.casePackPath;
        else externalCases = suite.casePaths;
      }
      if (isXiaobaOSTarget(target)) {
        requireCaseSource(casePath, casePackPath);
        const roleId = required(
          stringFlag(parsed.flags.role) ?? (profile?.kind === "xiaobaos" ? profile.role : undefined),
          "--role <xiaoba-role-id> is required for --target xiaobaos"
        );
        const live = requiredLivePolicy(parsed.flags, project, profile);
        const result = await runXiaoBaNativeEvaluation({
          request: createXiaoBaNativeSkillRequest({
            roleId,
            skillPath,
            ...(casePath && { casePaths: [casePath] }),
            ...(casePackPath && { casePackPath }),
            attemptsPerArm: resolvedAttempts(parsed.flags, project, 2),
            ...nativeInputFlags(parsed.flags, project, profile),
          }),
          runs_root: resolvedRoot(parsed.flags, project, "runs"),
          accepted_scan_finding_ids: live.policy.accepted_scan_finding_ids,
          live_policy_binding: live,
          preflight_only: parsed.flags["preflight-only"] === true,
        });
        printJson(result);
        return exitCodeForDecision(result.decision);
      }
      if (casePackPath) throw new Error("--case-pack is supported only for --target xiaobaos");
      const externalTarget = safeTargetId(target);
      const cases = externalCases ?? [required(casePath, `--case <case.json> or --suite <suite> is required for --target ${externalTarget}`)];
      const targetCommand = stringFlag(parsed.flags["target-command"]) ?? profileCommand(project, profile) ?? undefined;
      const envAllowlist = profile?.env_allowlist ?? [];
      const targetAdapter = externalTarget === "openclaw"
        ? new OpenClawTargetAdapter({ command: targetCommand, envAllowlist })
        : new PortableTargetAdapter({
            command: required(targetCommand, `--target-command <driver> is required for portable target ${externalTarget}`),
            runtime: externalTarget,
            envAllowlist,
          });
      const result = await runSkillEvaluation({
        skillPath,
        targetId: externalTarget,
        cases,
        attemptsPerArm: resolvedAttempts(parsed.flags, project, 2),
        runsRoot: resolvedRoot(parsed.flags, project, "runs"),
        targetAdapter,
        acceptedScanFindingIds: acceptedScanFindingIds(parsed.flags),
      });
      printJson(result);
      return exitCodeForDecision(result.decision);
    }

    if (effectiveCommand === "evaluate" && subcommand === "role") {
      const project = optionalProjectConfig(parsed.flags);
      const candidateRoleId = required(positionals[0], "Usage: barena evaluate role <candidate-role-id> --baseline-role <role-id> --case <case.json>|--case-pack <pack.json>");
      const baselineRoleId = required(stringFlag(parsed.flags["baseline-role"]) ?? undefined, "--baseline-role <xiaoba-role-id> is required");
      let casePath = stringFlag(parsed.flags.case) ?? undefined;
      let casePackPath = stringFlag(parsed.flags["case-pack"]) ?? undefined;
      const suiteName = stringFlag(parsed.flags.suite) ?? (!casePath && !casePackPath ? project?.config.defaults.suite : undefined);
      if (suiteName) {
        if (casePath || casePackPath) throw new Error("Use --suite, --case, or --case-pack; do not combine them");
        const suite = resolveBuiltinSuite({ suite: suiteName, targetId: "xiaobaos" });
        if (suite.kind !== "xiaoba_case_pack") throw new Error("Role evaluation requires a native SkillsBench case pack");
        casePackPath = suite.casePackPath;
      }
      requireCaseSource(casePath, casePackPath);
      const target = stringFlag(parsed.flags.target) ?? project?.config.default_target ?? "xiaobaos";
      if (!isXiaobaOSTarget(target)) throw new Error("Role evaluation currently supports only --target xiaobaos (xiaoba is a compatibility alias)");
      const profile = configuredProfile(project, target);
      const live = requiredLivePolicy(parsed.flags, project, profile);
      const result = await runXiaoBaNativeEvaluation({
        request: createXiaoBaNativeRoleRequest({
          baselineRoleId,
          candidateRoleId,
          ...(casePath && { casePaths: [casePath] }),
          ...(casePackPath && { casePackPath }),
          attemptsPerArm: resolvedAttempts(parsed.flags, project, 2),
          ...nativeInputFlags(parsed.flags, project, profile),
        }),
        runs_root: resolvedRoot(parsed.flags, project, "runs"),
        accepted_scan_finding_ids: live.policy.accepted_scan_finding_ids,
        live_policy_binding: live,
        preflight_only: parsed.flags["preflight-only"] === true,
      });
      printJson(result);
      return exitCodeForDecision(result.decision);
    }

    if (effectiveCommand === "show" || effectiveCommand === "scorecard") {
      const project = optionalProjectConfig(parsed.flags);
      const runId = required(subcommand, `Usage: barena ${effectiveCommand} <run-id>`);
      printJson(loadRunRecord(runId, resolvedRoot(parsed.flags, project, "runs")).result);
      return EXIT_SUCCESS;
    }

    if (effectiveCommand === "report") {
      const project = optionalProjectConfig(parsed.flags);
      const runId = required(subcommand, "Usage: barena report <run-id> [--format json|markdown]");
      const run = loadRunRecord(runId, resolvedRoot(parsed.flags, project, "runs"));
      const format = stringFlag(parsed.flags.format) ?? "markdown";
      if (format === "json") printJson(run.result);
      else if (format === "markdown") console.log(renderRunMarkdown(run));
      else throw new Error("--format must be json or markdown");
      return EXIT_SUCCESS;
    }

    if (effectiveCommand === "list" && subcommand === "subjects") {
      const project = optionalProjectConfig(parsed.flags);
      printJson(listSubjects(resolvedRoot(parsed.flags, project, "subjects")));
      return EXIT_SUCCESS;
    }

    if (effectiveCommand === "list" && subcommand === "runs") {
      const project = optionalProjectConfig(parsed.flags);
      printJson(listRunCatalog(resolvedRoot(parsed.flags, project, "runs")));
      return EXIT_SUCCESS;
    }

    if (effectiveCommand === "list" && (subcommand === "targets" || subcommand === "agents")) {
      printJson(listAgentTargets());
      return EXIT_SUCCESS;
    }

    if (effectiveCommand === "list" && subcommand === "suites") {
      printJson(listBuiltinSuites());
      return EXIT_SUCCESS;
    }

    if (effectiveCommand === "doctor") {
      const project = optionalProjectConfig(parsed.flags);
      const selectedTarget = stringFlag(parsed.flags.target) ?? project?.config.default_target;
      const result = selectedTarget
        ? await doctorTarget(selectedTarget, parsed.flags, project)
        : await doctor(nativeInputFlags(parsed.flags));
      printJson(result);
      return result.ok ? EXIT_SUCCESS : EXIT_HELD;
    }

    if (effectiveCommand === "tui") {
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

    throw new Error(`Unknown command: ${[effectiveCommand, subcommand].filter(Boolean).join(" ")}`);
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

async function doctorTarget(
  requestedTarget: string,
  flags: Record<string, FlagValue>,
  project: LoadedProjectConfig | undefined
): Promise<Record<string, unknown> & { ok: boolean }> {
  const packageMetadata = readPackageMetadata();
  const packageReady = packageMetadata.name === "barena" && typeof packageMetadata.version === "string";
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const nodeReady = Number.isInteger(nodeMajor) && nodeMajor >= minimumNodeMajor(packageMetadata.engines?.node);
  const targetId = requestedTarget === "xiaoba" ? "xiaobaos" : safeTargetId(requestedTarget);
  const profile = configuredProfile(project, targetId);
  const provider = providerReadiness(project?.config.provider);
  let target: { status: string };
  let livePolicy: Record<string, unknown> | undefined;

  if (targetId === "xiaobaos") {
    const native = createXiaoBaNativeRuntimeConfig(nativeInputFlags(flags, project, profile));
    target = await probeXiaoBaNativeRuntime(native.config);
    const policyPath = livePolicyPath(flags, project, profile);
    if (!policyPath) {
      livePolicy = {
        status: "blocked",
        detail: "XiaobaOS model-backed evaluation requires a configured live policy.",
      };
    } else {
      try {
        const binding = loadXiaoBaLivePolicy(policyPath);
        const envNames = [binding.policy.credential_env, binding.policy.api_base_env];
        const missing = envNames.filter((name) => !process.env[name]);
        livePolicy = {
          status: missing.length ? "blocked" : "ready",
          path: policyPath,
          provider: binding.policy.provider,
          model: binding.policy.model,
          credential_env: binding.policy.credential_env,
          api_base_env: binding.policy.api_base_env,
          missing_env: missing,
          detail: missing.length
            ? `Live-policy environment names are missing: ${missing.join(", ")}.`
            : "Live policy is valid and referenced environment names are present; secret values were not retained.",
        };
      } catch (error) {
        livePolicy = { status: "blocked", path: policyPath, detail: error instanceof Error ? error.message : String(error) };
      }
    }
  } else {
    const command = stringFlag(flags["target-command"]) ?? profileCommand(project, profile) ?? undefined;
    const envAllowlist = profile?.env_allowlist ?? [];
    const adapter = targetId === "openclaw"
      ? new OpenClawTargetAdapter({ command, envAllowlist })
      : new PortableTargetAdapter({
          command: required(command, `Target ${targetId} requires --target-command <driver> or a configured project target`),
          runtime: targetId,
          envAllowlist,
        });
    target = await adapter.probe();
  }

  const liveReady = targetId !== "xiaobaos" || livePolicy?.status === "ready";
  const ok = packageReady && nodeReady && target.status === "ready" && provider.status !== "blocked" && liveReady;
  return {
    ok,
    version: packageMetadata.version ?? "unknown",
    node: process.version,
    cwd: process.cwd(),
    config_path: project?.path ?? null,
    package: {
      status: packageReady ? "ready" : "blocked",
      name: packageMetadata.name ?? "unknown",
      version: packageMetadata.version ?? "unknown",
    },
    runtime: {
      status: nodeReady ? "ready" : "blocked",
      required: packageMetadata.engines?.node ?? "not recorded",
      platform: process.platform,
      architecture: process.arch,
    },
    selected_target: targetId,
    target,
    provider,
    ...(livePolicy && { live_policy: livePolicy }),
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

function requiredLivePolicy(
  flags: Record<string, FlagValue>,
  project?: LoadedProjectConfig,
  profile?: BarenaTargetProfile
): LoadedXiaoBaLivePolicy {
  const policyValue = livePolicyPath(flags, project, profile);
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

function nativeInputFlags(
  flags: Record<string, FlagValue>,
  project?: LoadedProjectConfig,
  profile?: BarenaTargetProfile
): {
  binaryPath?: string;
  projectRoot?: string;
  rolesRoot?: string;
  passEnv?: string[];
} {
  const passEnv = stringFlag(flags["pass-env"]);
  const configuredEnv = profile?.env_allowlist ?? [];
  const command = aliasedFlag(flags, "xiaobaos-command", "xiaoba-command") ??
    (profile?.kind === "xiaobaos" ? profileCommand(project, profile) : undefined);
  const passEnvNames = [...new Set([
    ...configuredEnv,
    ...(passEnv ? passEnv.split(",").map((item) => item.trim()).filter(Boolean) : []),
  ])];
  return {
    binaryPath: command ?? undefined,
    projectRoot: aliasedFlag(flags, "xiaobaos-project-root", "xiaoba-project-root") ?? undefined,
    rolesRoot: stringFlag(flags["roles-root"]) ?? undefined,
    passEnv: passEnvNames.length ? passEnvNames : undefined,
  };
}

function optionalProjectConfig(flags: Record<string, FlagValue>): LoadedProjectConfig | undefined {
  return loadProjectConfig(process.cwd(), stringFlag(flags.config) ?? undefined);
}

function requiredProjectConfig(flags: Record<string, FlagValue>): LoadedProjectConfig {
  const loaded = optionalProjectConfig(flags);
  if (!loaded) throw new Error("No Barena project config found. Run barena init first.");
  return loaded;
}

function configuredProfile(project: LoadedProjectConfig | undefined, targetId: string): BarenaTargetProfile | undefined {
  if (!project) return undefined;
  const normalized = targetId === "xiaoba" ? "xiaobaos" : targetId;
  return project.config.targets[normalized];
}

function profileCommand(project: LoadedProjectConfig | undefined, profile: BarenaTargetProfile | undefined): string | null {
  if (!profile) return null;
  return project ? resolveConfigReference(project, profile.command) : profile.command;
}

function livePolicyPath(
  flags: Record<string, FlagValue>,
  project?: LoadedProjectConfig,
  profile?: BarenaTargetProfile
): string | null {
  const explicit = stringFlag(flags["live-policy"]);
  if (explicit) return path.resolve(explicit);
  if (profile?.kind !== "xiaobaos" || !profile.live_policy) return null;
  return project ? resolveConfigReference(project, profile.live_policy) : path.resolve(profile.live_policy);
}

function resolvedAttempts(flags: Record<string, FlagValue>, project: LoadedProjectConfig | undefined, fallback: number): number {
  return flags.attempts === undefined
    ? project?.config.defaults.attempts ?? fallback
    : numberFlag(flags.attempts, fallback);
}

function resolvedRoot(
  flags: Record<string, FlagValue>,
  project: LoadedProjectConfig | undefined,
  kind: "runs" | "subjects"
): string {
  const flag = kind === "runs" ? "runs-root" : "subjects-root";
  const explicit = stringFlag(flags[flag]);
  if (explicit) return explicit;
  if (!project) return kind;
  const configured = kind === "runs" ? project.config.defaults.runs_root : project.config.defaults.subjects_root;
  return path.resolve(project.root, configured);
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
  barena init --target openclaw [--provider openai --model <model> --api-key-env OPENAI_API_KEY]
  barena eval skill <path>            # uses .barena/config.json defaults
  barena                              # guided Skill evaluation
  barena guide [--subjects-root path] [--runs-root path]

Evaluate a change:
  barena evaluate skill <path> --target xiaobaos --role <role-id> (--case <native-case.json> | --case-pack <pack.json>) --live-policy <policy.json> [--preflight-only]
  barena evaluate role <candidate-role-id> --baseline-role <role-id> (--case <native-case.json> | --case-pack <pack.json>) --live-policy <policy.json> [--preflight-only]
  barena evaluate skill <path> --target openclaw --case <agent-case.json> [--attempts 2]
  barena evaluate skill <path> --target hermes --target-command ./driver --case <portable-case.json> [--attempts 2]
  barena eval skill <path> --suite skillsbench:starter

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
  barena list suites
  barena config show
  barena tui [--snapshot] [--color|--no-color]  # advanced evidence TUI
  barena doctor [--target <id>]

Exit codes:
  0  cleared / ready / successful read
  1  held / blocked
  2  rejected / unsafe
  3  usage / configuration / schema / I/O / internal error
`);
}
