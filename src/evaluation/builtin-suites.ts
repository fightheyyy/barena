import fs from "node:fs";
import path from "node:path";
import type { AgentE2ECaseV1 } from "../e2e/types";
import { ensureDir, readJson, writeJson } from "../utils/fs";
import type { XiaoBaNativeCaseV1 } from "./xiaoba-native-types";

const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");
const STARTER_PACK_ROOT = path.join(PACKAGE_ROOT, "calibration", "skillsbench", "dialogue-graph-mini");
const STARTER_PACK_PATH = path.join(STARTER_PACK_ROOT, "case-pack.json");
const STARTER_CASE_PATH = path.join(STARTER_PACK_ROOT, "cases", "dialogue-graph-mini.json");

export interface BuiltinSuiteInfo {
  id: string;
  aliases: string[];
  source: "skillsbench";
  source_revision: string;
  task_count: number;
  task_ids: string[];
  supported_targets: string[];
  official_harness_result: false;
  detail: string;
}

export interface ResolveBuiltinSuiteOptions {
  suite: string;
  targetId: string;
  outputRoot?: string;
  agent?: string;
  model?: string;
  envAllowlist?: string[];
}

export type ResolvedBuiltinSuite =
  {
      kind: "portable_cases";
      suite: BuiltinSuiteInfo;
      casePaths: string[];
      generatedRoot: string;
    };

export function listBuiltinSuites(): BuiltinSuiteInfo[] {
  const pack = readJson<Record<string, unknown>>(STARTER_PACK_PATH);
  const source = record(pack.source, "SkillsBench starter source");
  const cases = Array.isArray(pack.cases) ? pack.cases : [];
  const taskIds = cases.map((entry, index) => {
    const caseEntry = record(entry, `SkillsBench starter case ${index}`);
    return requiredString(record(caseEntry.source_task, `SkillsBench starter source task ${index}`).task_id, "task id");
  });
  return [{
    id: "skillsbench:dialogue-graph-mini",
    aliases: ["skillsbench:starter"],
    source: "skillsbench",
    source_revision: requiredString(source.revision, "SkillsBench source revision"),
    task_count: taskIds.length,
    task_ids: taskIds,
    supported_targets: ["xiaobaos", "openclaw", "portable"],
    official_harness_result: false,
    detail: "Pinned SkillsBench-derived onboarding calibration with trusted structured artifact verification.",
  }];
}

export function resolveBuiltinSuite(options: ResolveBuiltinSuiteOptions): ResolvedBuiltinSuite {
  const suite = findSuite(options.suite);
  const targetId = normalizeTarget(options.targetId);
  const outputRoot = path.resolve(options.outputRoot ?? path.join(".barena", "generated"));
  const generatedRoot = path.join(outputRoot, "suites", safeSegment(suite.id), safeSegment(targetId));
  const fixturesRoot = path.join(generatedRoot, "fixtures");
  ensureDir(fixturesRoot);
  const nativeCase = readJson<XiaoBaNativeCaseV1>(STARTER_CASE_PATH);
  const fixtures = (nativeCase.fixtures ?? []).map((fixture, index) => {
    const source = resolveInside(
      STARTER_PACK_ROOT,
      path.resolve(path.dirname(STARTER_CASE_PATH), fixture.source_path),
      "SkillsBench fixture"
    );
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw new Error(`SkillsBench starter fixture does not exist: ${source}`);
    }
    const relativeSource = path.join("fixtures", `${index + 1}-${path.basename(source)}`);
    fs.copyFileSync(source, path.join(generatedRoot, relativeSource));
    return { source: relativeSource, destination: fixture.destination };
  });
  const envAllowlist = uniqueEnvNames(options.envAllowlist ?? []);
  const caseDefinition: AgentE2ECaseV1 = {
    schema: "barena.agent_e2e_case.v1",
    case_id: nativeCase.case_id,
    target: targetId === "openclaw"
      ? {
          adapter: "openclaw",
          agent: options.agent ?? "main",
          ...(options.model && { model: options.model }),
          env_allowlist: envAllowlist,
        }
      : targetId === "xiaobaos"
        ? {
            adapter: "xiaoba",
            runtime: "xiaobaos",
            agent: requiredSafeAgent(options.agent, "XiaobaOS built-in suites require --role <role-id>"),
            ...(options.model && { model: options.model }),
            env_allowlist: envAllowlist,
          }
        : {
          adapter: "portable",
          runtime: targetId,
          ...(options.agent && { agent: options.agent }),
          ...(options.model && { model: options.model }),
          env_allowlist: envAllowlist,
        },
    task: nativeCase.task,
    fixtures,
    assertions: nativeCase.assertions,
    replays: 0,
    timeout_ms: nativeCase.timeout_ms ?? 600_000,
    isolation: {
      level: "policy_only",
      network: "allowlisted",
      writable_roots: ["workspace"],
    },
  };
  const casePath = path.join(generatedRoot, "case.json");
  writeJson(casePath, caseDefinition);
  writeJson(path.join(generatedRoot, "source.json"), {
    schema: "barena.builtin_suite_materialization.v1",
    suite: suite.id,
    alias_requested: options.suite,
    source: "skillsbench",
    source_revision: suite.source_revision,
    task_ids: suite.task_ids,
    target: targetId,
    official_harness_result: false,
  });
  return { kind: "portable_cases", suite, casePaths: [casePath], generatedRoot };
}

function findSuite(value: string): BuiltinSuiteInfo {
  const normalized = value.trim().toLowerCase();
  const suite = listBuiltinSuites().find((entry) => entry.id === normalized || entry.aliases.includes(normalized));
  if (!suite) throw new Error(`Unknown built-in suite: ${value}. Run barena list suites.`);
  return suite;
}

function normalizeTarget(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error("Suite target must be a safe identifier");
  return value === "xiaoba" ? "xiaobaos" : value;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function uniqueEnvNames(values: string[]): string[] {
  const names = [...new Set(values)];
  if (names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new Error("Suite environment allowlist contains an invalid name");
  }
  return names;
}

function resolveInside(root: string, candidate: string, label: string): string {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the bundled calibration root`);
  }
  return candidate;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requiredSafeAgent(value: string | undefined, message: string): string {
  if (!value || !/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") throw new Error(message);
  return value;
}
