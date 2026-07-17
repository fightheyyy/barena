import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadSkillSelection } from "./run-skill-evaluation";
import {
  XIAOBA_NATIVE_CONTRACT_VERSION,
  XiaoBaCapabilityEvaluationRequestV1,
  XiaoBaNativeCaseV1,
  XiaoBaNativeRoleSource,
  XiaoBaNativeRuntimeConfig,
} from "./xiaoba-native-types";
import { hashDirectory } from "../utils/fs";

const DEFAULT_PASS_ENV = [
  "XIAOBA_LLM_API_KEY",
  "XIAOBA_LLM_API_BASE",
  "XIAOBA_LLM_MODEL",
  "XIAOBA_LLM_PROVIDER",
] as const;

export interface XiaoBaNativeInputOptions {
  binaryPath?: string;
  projectRoot?: string;
  rolesRoot?: string;
  passEnv?: string[];
}

export interface CreateXiaoBaSkillRequestOptions extends XiaoBaNativeInputOptions {
  roleId: string;
  skillPath: string;
  casePaths: string[];
  attemptsPerArm: number;
}

export interface CreateXiaoBaRoleRequestOptions extends XiaoBaNativeInputOptions {
  baselineRoleId: string;
  candidateRoleId: string;
  casePaths: string[];
  attemptsPerArm: number;
}

export function createXiaoBaNativeSkillRequest(
  options: CreateXiaoBaSkillRequestOptions
): XiaoBaCapabilityEvaluationRequestV1 {
  const resolved = resolveNativeInputs(options);
  const role = loadXiaoBaRoleSource(options.roleId, resolved.rolesRoot);
  const skill = loadSkillSelection(options.skillPath);
  return {
    schema: "barena.xiaoba_capability_evaluation_request.v1",
    evaluation_id: createEvaluationId("skill"),
    created_at: new Date().toISOString(),
    target_runtime: "xiaoba",
    evaluator_runtime: "xiaoba-cli",
    capability_kind: "skill",
    xiaoba: resolved.config,
    cases: options.casePaths.map(loadXiaoBaNativeCase),
    attempts_per_arm: validateAttempts(options.attemptsPerArm),
    baseline: { mode: "role", role },
    candidate: {
      mode: "role_skill",
      role,
      skill: {
        name: skill.name,
        source_path: skill.source_path,
        fingerprint: skill.fingerprint,
      },
    },
  };
}

export function createXiaoBaNativeRoleRequest(
  options: CreateXiaoBaRoleRequestOptions
): XiaoBaCapabilityEvaluationRequestV1 {
  const resolved = resolveNativeInputs(options);
  const baseline = loadXiaoBaRoleSource(options.baselineRoleId, resolved.rolesRoot);
  const candidate = loadXiaoBaRoleSource(options.candidateRoleId, resolved.rolesRoot);
  return {
    schema: "barena.xiaoba_capability_evaluation_request.v1",
    evaluation_id: createEvaluationId("role"),
    created_at: new Date().toISOString(),
    target_runtime: "xiaoba",
    evaluator_runtime: "xiaoba-cli",
    capability_kind: "role",
    xiaoba: resolved.config,
    cases: options.casePaths.map(loadXiaoBaNativeCase),
    attempts_per_arm: validateAttempts(options.attemptsPerArm),
    baseline: { mode: "role", role: baseline },
    candidate: { mode: "role", role: candidate },
  };
}

export function createXiaoBaNativeRuntimeConfig(
  options: XiaoBaNativeInputOptions = {}
): { config: XiaoBaNativeRuntimeConfig; rolesRoot: string } {
  const binaryPath = resolveExecutable(options.binaryPath ?? "xiaoba");
  const projectRoot = path.resolve(options.projectRoot ?? inferProjectRoot(binaryPath));
  const rolesRoot = path.resolve(options.rolesRoot ?? process.env.XIAOBA_ROLES_ROOT ?? path.join(projectRoot, "roles"));
  const passEnv = [...new Set(options.passEnv ?? DEFAULT_PASS_ENV)].map((name) => validateEnvName(name));
  return {
    config: {
      binary_path: binaryPath,
      project_root: projectRoot,
      expected_version: XIAOBA_NATIVE_CONTRACT_VERSION,
      pass_env: passEnv,
      surface: "pet",
      sandbox_engine: process.platform === "darwin" ? "macos_seatbelt" : "linux_bubblewrap",
    },
    rolesRoot,
  };
}

export function loadXiaoBaNativeCase(casePath: string): XiaoBaNativeCaseV1 {
  const absolutePath = path.resolve(casePath);
  const value = JSON.parse(fs.readFileSync(absolutePath, "utf8")) as XiaoBaNativeCaseV1;
  if (value?.schema !== "barena.xiaoba_native_case.v1") {
    throw new Error("XiaoBa native case schema must be barena.xiaoba_native_case.v1");
  }
  if (!value.case_id || !/^[A-Za-z0-9._-]+$/.test(value.case_id)) {
    throw new Error("XiaoBa native case_id must contain only letters, numbers, dot, underscore, or dash");
  }
  if (!["effectiveness", "regression", "safety"].includes(value.purpose)) {
    throw new Error("XiaoBa native case purpose must be effectiveness, regression, or safety");
  }
  if (!value.task?.prompt?.trim()) throw new Error("XiaoBa native case task.prompt must be non-empty");
  if (!Array.isArray(value.assertions?.artifacts)) throw new Error("XiaoBa native case assertions.artifacts must be an array");
  const caseDir = path.dirname(absolutePath);
  return {
    ...value,
    fixtures: value.fixtures?.map((fixture) => ({
      ...fixture,
      source_path: path.isAbsolute(fixture.source_path)
        ? fixture.source_path
        : path.resolve(caseDir, fixture.source_path),
    })),
  };
}

export function loadXiaoBaRoleSource(roleId: string, rolesRoot: string): XiaoBaNativeRoleSource {
  const normalized = roleId.trim();
  if (!normalized || !/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error("XiaoBa Role ID must contain only letters, numbers, dot, underscore, or dash");
  }
  const sourcePath = path.resolve(rolesRoot, normalized);
  const relative = path.relative(path.resolve(rolesRoot), sourcePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("XiaoBa Role must stay inside roles root");
  const manifestPath = path.join(sourcePath, "role.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`XiaoBa Role not found: ${normalized} (${manifestPath})`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { name?: string };
  if (manifest.name !== normalized) {
    throw new Error(`XiaoBa Role manifest name ${String(manifest.name)} does not match requested ID ${normalized}`);
  }
  return { role_id: normalized, source_path: sourcePath, fingerprint: hashDirectory(sourcePath) };
}

function resolveNativeInputs(options: XiaoBaNativeInputOptions): {
  config: XiaoBaNativeRuntimeConfig;
  rolesRoot: string;
} {
  return createXiaoBaNativeRuntimeConfig(options);
}

function resolveExecutable(command: string): string {
  if (command.includes(path.sep)) return path.resolve(command);
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(entry, command);
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
  }
  return command;
}

function inferProjectRoot(binaryPath: string): string {
  if (!path.isAbsolute(binaryPath) || !fs.existsSync(binaryPath)) return process.cwd();
  const real = fs.realpathSync(binaryPath);
  const parent = path.dirname(real);
  return path.basename(parent) === "dist" ? path.dirname(parent) : path.dirname(real);
}

function validateAttempts(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 11) {
    throw new Error("attempts per arm must be an integer from 1 to 11");
  }
  return value;
}

function validateEnvName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid --pass-env name: ${value}`);
  return value;
}

function createEvaluationId(kind: "skill" | "role"): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `xiaoba-${kind}-eval-${timestamp}-${crypto.randomBytes(3).toString("hex")}`;
}
