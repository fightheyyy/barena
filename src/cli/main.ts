import fs from "node:fs";
import path from "node:path";
import { importAgentTarget, listAgentTargets } from "../agents/targets";
import { runClearance } from "../domain/clearance";
import type { SubjectManifest } from "../domain/types";
import { loadAgentE2ECase, probeAgentE2E, runAgentE2ECase } from "../e2e/case-runner";
import { runSkillEvaluation } from "../evaluation/run-skill-evaluation";
import { listBuiltinSuites, resolveBuiltinSuite } from "../evaluation/builtin-suites";
import { renderRunMarkdown } from "../reports/report";
import { listRunCatalog, loadRunRecord } from "../runs/catalog";
import { importGithubSkill } from "../subjects/github-importer";
import { importLocalSkill, loadSubjectManifest } from "../subjects/importer";
import { scanSubjectDirectory } from "../subjects/scanner";
import {
  createAdHocExploreScenario,
  loadExploreScenario,
  runConnectedExploreScenario,
} from "../explore";
import { loadAgentSimulationCase, runAgentSimulationCase } from "../simulation";
import { OpenClawTargetAdapter } from "../targets/openclaw-target-adapter";
import { PortableTargetAdapter } from "../targets/portable-target-adapter";
import { XiaobaTargetAdapter } from "../targets/xiaoba-target-adapter";
import {
  XiaobaOSRuntimeAdapter,
  type RuntimeTelemetryConfig,
  type XiaobaOSRuntimeAdapterConfig,
} from "../runtime-adapters";
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
const BOOLEAN_FLAGS = new Set(["help", "version", "color", "no-color", "snapshot", "force"]);
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
  "accept-scan-findings",
  "config",
  "provider",
  "model",
  "api-key-env",
  "api-base-env",
  "agent",
  "suite",
  "runtime",
  "task",
  "scenario-id",
  "max-turns",
  "timeout",
  "skill",
  "otlp-traces-endpoint",
  "otlp-protocol",
  "otlp-headers",
  "otel-service-name",
  "traceparent",
  "tracestate",
]);
const KNOWN_COMMANDS = new Set([
  "compare",
  "config",
  "doctor",
  "e2e",
  "evaluate",
  "explore",
  "guide",
  "help",
  "import",
  "init",
  "list",
  "replay",
  "report",
  "run",
  "scan",
  "scorecard",
  "show",
  "simulation",
  "tui",
  "version",
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
    if (parsed.flags.help) {
      if (!command) printHelp();
      else if (KNOWN_COMMANDS.has(effectiveCommand)) printCommandHelp(effectiveCommand);
      else throw new Error(`Unknown command: ${command}`);
      return EXIT_SUCCESS;
    }
    if (command === "help") {
      const topic = subcommand === "eval" ? "evaluate" : subcommand;
      if (!topic) printHelp();
      else if (KNOWN_COMMANDS.has(topic)) printCommandHelp(topic);
      else throw new Error(`Unknown command: ${topic}`);
      return EXIT_SUCCESS;
    }
    if (!command) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        const project = optionalProjectConfig(parsed.flags);
        const profile = configuredProfile(project, "xiaobaos");
        const xiaoba = createXiaobaRuntimeConfig(parsed.flags, project, profile);
        await startEvaluationTui({
          runsRoot: resolvedRoot(parsed.flags, project, "runs"),
          homeMode: "product",
          initialWorkflow: "home",
          ...tuiXiaobaOptions(xiaoba, project?.config.provider?.model),
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
        projectRoot: aliasedFlag(parsed.flags, "xiaobaos-project-root", "xiaoba-project-root") ?? undefined,
        rolesRoot: stringFlag(parsed.flags["roles-root"]) ?? undefined,
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

    if (effectiveCommand === "explore") {
      const project = optionalProjectConfig(parsed.flags);
      const profile = configuredProfile(project, "xiaobaos");
      const positionalInput = [subcommand, ...positionals]
        .filter((value): value is string => Boolean(value))
        .join(" ")
        .trim();
      const scenarioInput = positionalInput &&
        (positionalInput.toLowerCase().endsWith(".json") ||
          fs.existsSync(path.resolve(positionalInput)))
        ? positionalInput
        : undefined;
      const objectiveInput = positionalInput && !scenarioInput
        ? positionalInput
        : undefined;
      const hasAutomationFlags =
        stringFlag(parsed.flags.role) !== null ||
        stringFlag(parsed.flags.task) !== null;
      if (!scenarioInput && !hasAutomationFlags && process.stdin.isTTY && process.stdout.isTTY) {
        const xiaoba = createXiaobaRuntimeConfig(parsed.flags, project, profile);
        await startEvaluationTui({
          runsRoot: resolvedRoot(parsed.flags, project, "runs"),
          homeMode: "product",
          initialWorkflow: "explore",
          initialExploreTask: objectiveInput,
          initialExploreMaxTurns:
            parsed.flags["max-turns"] === undefined
              ? undefined
              : numberFlag(parsed.flags["max-turns"], 6),
          ...tuiXiaobaOptions(xiaoba, project?.config.provider?.model),
        });
        return EXIT_SUCCESS;
      }
      const runtime =
        stringFlag(parsed.flags.runtime) ??
        stringFlag(parsed.flags.target) ??
        "xiaobaos";
      if (!isXiaobaOSTarget(runtime)) {
        throw new Error(
          `Runtime ${runtime} may be installed, but its Barena Explore adapter is not implemented yet.`
        );
      }
      const scenario = scenarioInput
        ? loadExploreScenario(scenarioInput)
        : createAdHocExploreScenario({
            role:
              stringFlag(parsed.flags.role) ??
              (profile?.kind === "xiaobaos" ? profile.role : undefined) ??
              "base",
            task: required(
              stringFlag(parsed.flags.task) ?? objectiveInput,
              "Usage: barena explore <objective> [--role <role>]"
            ),
            scenario_id: stringFlag(parsed.flags["scenario-id"]) ?? undefined,
            model:
              stringFlag(parsed.flags.model) ??
              project?.config.provider?.model ??
              undefined,
            skill: stringFlag(parsed.flags.skill) ?? undefined,
            max_turns: numberFlag(parsed.flags["max-turns"], 6),
            timeout_ms: numberFlag(parsed.flags.timeout, 180_000),
            env_allowlist: createXiaobaRuntimeConfig(
              parsed.flags,
              project,
              profile
            ).env_allowlist,
          });
      const result = await runConnectedExploreScenario(scenario, {
        runs_root: resolvedRoot(parsed.flags, project, "runs"),
        xiaoba: createXiaobaRuntimeConfig(parsed.flags, project, profile),
      });
      printJson({
        schema: result.schema,
        run_id: result.run_id,
        scenario_id: result.scenario_id,
        status: result.status,
        summary: result.summary,
        runtime: result.scenario.target.runtime,
        role: result.scenario.target.role,
        target_turns: result.turns.filter((turn) => turn.target).length,
        issues:
          result.inspector.status === "completed"
            ? result.inspector.output.issues.length
            : 0,
        otlp: {
          envelopes: result.evidence.native_otlp_envelopes,
          spans: result.evidence.native_otlp_spans,
          complete: result.evidence.evidence_complete,
        },
        replay_case_candidates: result.replay_case_candidates.length,
        report: result.paths.report_markdown,
        result: result.paths.report_json,
      });
      if (result.status === "pass") return EXIT_SUCCESS;
      if (result.status === "unsafe") return 2;
      return EXIT_HELD;
    }

    if (effectiveCommand === "simulation" && subcommand === "run") {
      const casePath = required(
        positionals[0],
        "Usage: barena simulation run <case.json> [--runs-root runs] [--otlp-traces-endpoint URL]"
      );
      const caseDefinition = loadAgentSimulationCase(casePath);
      if (!isXiaobaOSTarget(caseDefinition.target.adapter)) {
        throw new Error(
          `Simulation Runtime ${caseDefinition.target.adapter} is not implemented on the canonical AgentRuntimeAdapter yet.`
        );
      }
      const project = optionalProjectConfig(parsed.flags);
      const profile = configuredProfile(project, "xiaobaos");
      const config = createXiaobaRuntimeConfig(parsed.flags, project, profile);
      const result = await runAgentSimulationCase(caseDefinition, {
        runsRoot: resolvedRoot(parsed.flags, project, "runs"),
        telemetry: simulationTelemetry(parsed.flags),
        adapter: new XiaobaOSRuntimeAdapter({
          ...config,
          env_allowlist: [
            ...new Set([
              ...(config.env_allowlist ?? []),
              ...(caseDefinition.target.env_allowlist ?? []),
            ]),
          ],
        }),
      });
      printJson(result);
      return result.status === "pass" ? EXIT_SUCCESS : EXIT_HELD;
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
      const targetCommand = stringFlag(parsed.flags["target-command"]) ?? profileCommand(project, profile) ?? undefined;
      const envAllowlist = profile?.env_allowlist ?? [];
      const targetAdapter = isXiaobaOSTarget(targetId)
        ? createXiaobaTargetAdapter(parsed.flags, project, profile)
        : targetId === "openclaw"
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

    if (
      (effectiveCommand === "e2e" && subcommand === "run") ||
      effectiveCommand === "replay"
    ) {
      const casePath =
        effectiveCommand === "replay"
          ? required(
              subcommand,
              "Usage: barena replay <case.json> [--target-command ./driver] [--runs-root runs]"
            )
          : required(
              positionals[0],
              "Usage: barena e2e run <case.json> [--runs-root runs]"
            );
      const loaded = loadAgentE2ECase(casePath);
      const project = optionalProjectConfig(parsed.flags);
      const caseTargetId = loaded.caseDefinition.target.adapter === "openclaw"
        ? "openclaw"
        : loaded.caseDefinition.target.adapter === "xiaoba"
          ? "xiaobaos"
          : loaded.caseDefinition.target.runtime;
      const profile = caseTargetId ? configuredProfile(project, caseTargetId) : undefined;
      const targetCommand = stringFlag(parsed.flags["target-command"]) ?? profileCommand(project, profile) ?? undefined;
      const envAllowlist = [...new Set([...(profile?.env_allowlist ?? []), ...(loaded.caseDefinition.target.env_allowlist ?? [])])];
      const targetAdapter = loaded.caseDefinition.target.adapter === "xiaoba"
        ? createXiaobaTargetAdapter(parsed.flags, project, profile, envAllowlist)
        : loaded.caseDefinition.target.adapter === "openclaw"
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

    if (
      (effectiveCommand === "evaluate" && subcommand === "skill") ||
      effectiveCommand === "compare"
    ) {
      const project = optionalProjectConfig(parsed.flags);
      const skillPath =
        effectiveCommand === "compare"
          ? required(
              subcommand,
              "Usage: barena compare <candidate-skill> [--suite skillsbench:starter|--case <case.json>] [--attempts 2]"
            )
          : required(
              positionals[0],
              "Usage: barena eval skill <skill-path> [--suite skillsbench:starter|--case <case.json>|--case-pack <pack.json>]"
            );
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
          agent: isXiaobaOSTarget(target)
            ? stringFlag(parsed.flags.role) ?? (profile?.kind === "xiaobaos" ? profile.role : undefined)
            : profile?.kind === "openclaw" || profile?.kind === "portable" ? profile.agent : undefined,
          model: project?.config.provider?.model,
          envAllowlist: profile?.env_allowlist,
        });
        externalCases = suite.casePaths;
      }
      if (casePackPath) {
        throw new Error("--case-pack used the removed XiaobaOS Arena path; use --suite skillsbench:starter or a barena.agent_e2e_case.v1 --case instead");
      }
      const externalTarget = safeTargetId(target);
      const cases = externalCases ?? [required(casePath, `--case <case.json> or --suite <suite> is required for --target ${externalTarget}`)];
      const targetCommand = stringFlag(parsed.flags["target-command"]) ?? profileCommand(project, profile) ?? undefined;
      const envAllowlist = profile?.env_allowlist ?? [];
      const targetAdapter = isXiaobaOSTarget(externalTarget)
        ? createXiaobaTargetAdapter(parsed.flags, project, profile, envAllowlist)
        : externalTarget === "openclaw"
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
      throw new Error(
        "Role A/B is temporarily held while it is migrated to Barena-owned ordinary target execution; Barena will not fall back to XiaobaOS Arena"
      );
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
        : await doctor(xiaobaAdapterFlags(parsed.flags));
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
        const project = optionalProjectConfig(parsed.flags);
        const profile = configuredProfile(project, "xiaobaos");
        const xiaoba = createXiaobaRuntimeConfig(parsed.flags, project, profile);
        await startEvaluationTui({
          runsRoot: resolvedRoot(parsed.flags, project, "runs"),
          color,
          homeMode: "product",
          initialWorkflow: "home",
          ...tuiXiaobaOptions(xiaoba, project?.config.provider?.model),
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

export async function doctor(options: ReturnType<typeof xiaobaAdapterFlags> = {}): Promise<Record<string, unknown> & { ok: boolean }> {
  const packageMetadata = readPackageMetadata();
  const packageReady = packageMetadata.name === "barena" && typeof packageMetadata.version === "string";
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const nodeReady = Number.isInteger(nodeMajor) && nodeMajor >= minimumNodeMajor(packageMetadata.engines?.node);
  const xiaoba = await new XiaobaTargetAdapter({
    command: options.command,
    projectRoot: options.projectRoot,
    rolesRoot: options.rolesRoot,
    envAllowlist: options.envAllowlist,
  }).probe();
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
  if (targetId === "xiaobaos") {
    target = await createXiaobaTargetAdapter(flags, project, profile).probe();
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

  const ok = packageReady && nodeReady && target.status === "ready" && provider.status !== "blocked";
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

function acceptedScanFindingIds(flags: Record<string, FlagValue>): string[] {
  const value = stringFlag(flags["accept-scan-findings"]);
  if (!value) return [];
  const findingIds = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (!findingIds.length || findingIds.some((item) => !/^[A-Za-z0-9._:-]+$/.test(item))) {
    throw new Error("--accept-scan-findings must be a comma-separated list of finding IDs");
  }
  return [...new Set(findingIds)];
}

function xiaobaAdapterFlags(
  flags: Record<string, FlagValue>,
  project?: LoadedProjectConfig,
  profile?: BarenaTargetProfile
): {
  command?: string;
  projectRoot?: string;
  rolesRoot?: string;
  envAllowlist?: string[];
} {
  const passEnv = stringFlag(flags["pass-env"]);
  const configuredEnv = profile?.env_allowlist ?? [];
  const command = stringFlag(flags["target-command"]) ?? aliasedFlag(flags, "xiaobaos-command", "xiaoba-command") ??
    (profile?.kind === "xiaobaos" ? profileCommand(project, profile) : undefined);
  const passEnvNames = [...new Set([
    ...configuredEnv,
    ...(passEnv ? passEnv.split(",").map((item) => item.trim()).filter(Boolean) : []),
  ])];
  return {
    command: command ?? undefined,
    projectRoot: aliasedFlag(flags, "xiaobaos-project-root", "xiaoba-project-root") ??
      (profile?.kind === "xiaobaos" && profile.project_root
        ? project ? resolveConfigReference(project, profile.project_root) : path.resolve(profile.project_root)
        : undefined),
    rolesRoot: stringFlag(flags["roles-root"]) ??
      (profile?.kind === "xiaobaos" && profile.roles_root
        ? project ? resolveConfigReference(project, profile.roles_root) : path.resolve(profile.roles_root)
        : undefined),
    envAllowlist: passEnvNames.length ? passEnvNames : undefined,
  };
}

function createXiaobaTargetAdapter(
  flags: Record<string, FlagValue>,
  project?: LoadedProjectConfig,
  profile?: BarenaTargetProfile,
  extraEnvAllowlist: string[] = []
): XiaobaTargetAdapter {
  const config = xiaobaAdapterFlags(flags, project, profile);
  return new XiaobaTargetAdapter({
    command: config.command,
    projectRoot: config.projectRoot,
    rolesRoot: config.rolesRoot,
    envAllowlist: [...new Set([...(config.envAllowlist ?? []), ...extraEnvAllowlist])],
  });
}

function createXiaobaRuntimeConfig(
  flags: Record<string, FlagValue>,
  project?: LoadedProjectConfig,
  profile?: BarenaTargetProfile
): XiaobaOSRuntimeAdapterConfig {
  const config = xiaobaAdapterFlags(flags, project, profile);
  return {
    command: config.command,
    project_root: config.projectRoot,
    roles_root: config.rolesRoot,
    env_allowlist: config.envAllowlist,
  };
}

function simulationTelemetry(
  flags: Record<string, FlagValue>
): RuntimeTelemetryConfig | undefined {
  const tracesEndpoint = stringFlag(flags["otlp-traces-endpoint"])
    ?? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    ?? undefined;
  if (!tracesEndpoint) return undefined;
  const protocol = stringFlag(flags["otlp-protocol"])
    ?? process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL
    ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL
    ?? "http/protobuf";
  if (protocol !== "http/protobuf" && protocol !== "http/json") {
    throw new Error("--otlp-protocol must be http/protobuf or http/json");
  }
  const rawHeaders = stringFlag(flags["otlp-headers"])
    ?? process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS
    ?? process.env.OTEL_EXPORTER_OTLP_HEADERS;
  return {
    traces_endpoint: tracesEndpoint,
    protocol,
    headers: rawHeaders ? parseOtlpHeaders(rawHeaders) : undefined,
    service_name: stringFlag(flags["otel-service-name"]) ?? undefined,
    traceparent: stringFlag(flags.traceparent) ?? undefined,
    tracestate: stringFlag(flags.tracestate) ?? undefined,
  };
}

function parseOtlpHeaders(value: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of value.split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new Error("OTLP headers must use comma-separated name=value entries");
    }
    const name = decodeURIComponent(entry.slice(0, separator).trim());
    const headerValue = decodeURIComponent(entry.slice(separator + 1).trim());
    if (!name) throw new Error("OTLP header name must not be empty");
    headers[name] = headerValue;
  }
  return headers;
}

function tuiXiaobaOptions(
  config: XiaobaOSRuntimeAdapterConfig,
  model?: string
): {
  xiaobaCommand?: string;
  xiaobaProjectRoot?: string;
  xiaobaRolesRoot?: string;
  xiaobaSkillsRoot?: string;
  xiaobaEnvAllowlist?: string[];
  exploreModel?: string;
} {
  return {
    ...(config.command && { xiaobaCommand: config.command }),
    ...(config.project_root && { xiaobaProjectRoot: config.project_root }),
    ...(config.roles_root && { xiaobaRolesRoot: config.roles_root }),
    ...(config.skills_root && { xiaobaSkillsRoot: config.skills_root }),
    ...(config.env_allowlist?.length && {
      xiaobaEnvAllowlist: config.env_allowlist,
    }),
    ...(model && { exploreModel: model }),
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
  console.log(`Barena - Agentic Eval and Release for Agent Harness Evolution

Start here:
  barena                              # full-screen product TUI: Explore / Replay / Compare
  barena explore                      # natural objective Composer; target is resolved automatically
  barena explore "<objective>"         # prefill the Composer and review one resolved plan
  barena explore --role <role-id> [--skill <skill-id>] --task "<objective>"
  barena replay <case.json> [--target-command ./driver]
  barena compare <candidate-skill> (--case <case.json> | --suite skillsbench:starter) [--attempts 2]
  barena simulation run <case.json> [--otlp-traces-endpoint URL]
  barena init --target openclaw [--provider openai --model <model> --api-key-env OPENAI_API_KEY]
  barena eval skill <path>            # uses .barena/config.json defaults
  barena guide                        # compatibility Skill-evaluation guide

Evaluate a change:
  barena evaluate skill <path> --target xiaobaos --role <role-id> --suite skillsbench:starter [--attempts 2]
  barena evaluate skill <path> --target xiaobaos --role <role-id> --case <agent-case.json> [--attempts 2]
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
  barena run <subject-id> [--replays 3] [--verifier path]  # legacy deterministic scaffold; not a real Agent eval
  barena e2e probe [--target xiaobaos|openclaw|hermes] [--target-command ./driver]
  barena e2e run <case.json> [--target-command ./driver] [--runs-root runs]
  barena list subjects
  barena list targets
  barena list suites
  barena config show
  barena tui [--snapshot] [--color|--no-color]  # product TUI compatibility entry
  barena doctor [--target <id>]

Exit codes:
  0  cleared / ready / successful read
  1  held / blocked
  2  rejected / unsafe
  3  usage / configuration / schema / I/O / internal error
`);
}

function printCommandHelp(command: string): void {
  if (command === "explore") {
    console.log(`Usage:
  barena explore
  barena explore "<objective>"
  barena explore <scenario.json>
  barena explore [--role <role-id>] [--skill <skill-id>] --task "<objective>"

Runs the UserCat → target Agent → InspectorCat → ReviewerCat Explore DAG.
Interactive use auto-detects XiaoBaOS and defaults to Base Agent; /agent and
/skill progressively override that target. Automation uses the same typed engine.`);
    return;
  }
  if (command === "replay") {
    console.log(`Usage:
  barena replay <case.json> [--target-command ./driver] [--runs-root runs]

Runs a fixed barena.agent_e2e_case.v1 through fresh workspace/session attempts,
deterministic Artifact verification, and replay aggregation.`);
    return;
  }
  if (command === "compare") {
    console.log(`Usage:
  barena compare <candidate-skill> --target <xiaobaos|openclaw|portable-id> \\
    (--case <case.json> | --suite skillsbench:starter) [--attempts 2]

Runs the same target and Case without versus with the candidate Skill, then emits
the verifier-backed lift, stability, regression, and cleared/held/rejected gate.`);
    return;
  }
  if (command === "simulation") {
    console.log(`Usage:
  barena simulation run <case.json> [--runs-root runs] [--otlp-traces-endpoint URL]

Runs attributed scripted turns against one AgentRuntimeAdapter session, applies
deterministic final-response assertions, and optionally exports a correlated
Run → Turn → Runtime → Check trace to Catena.`);
    return;
  }
  printHelp();
}
