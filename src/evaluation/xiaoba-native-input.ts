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
import { loadXiaoBaCasePack } from "./xiaoba-case-pack";
import { loadXiaoBaNativeCase } from "./xiaoba-native-case";
export { loadXiaoBaNativeCase } from "./xiaoba-native-case";

const DEFAULT_PASS_ENV: readonly string[] = [];

export interface XiaoBaNativeInputOptions {
  binaryPath?: string;
  projectRoot?: string;
  rolesRoot?: string;
  passEnv?: string[];
}

export interface CreateXiaoBaSkillRequestOptions extends XiaoBaNativeInputOptions {
  roleId: string;
  skillPath: string;
  casePaths?: string[];
  casePackPath?: string;
  attemptsPerArm: number;
}

export interface CreateXiaoBaRoleRequestOptions extends XiaoBaNativeInputOptions {
  baselineRoleId: string;
  candidateRoleId: string;
  casePaths?: string[];
  casePackPath?: string;
  attemptsPerArm: number;
}

export function createXiaoBaNativeSkillRequest(
  options: CreateXiaoBaSkillRequestOptions
): XiaoBaCapabilityEvaluationRequestV1 {
  const resolved = resolveNativeInputs(options);
  const role = loadXiaoBaRoleSource(options.roleId, resolved.rolesRoot);
  const skill = loadSkillSelection(options.skillPath);
  const caseInput = resolveCaseInput(options.casePaths, options.casePackPath);
  return {
    schema: "barena.xiaoba_capability_evaluation_request.v1",
    evaluation_id: createEvaluationId("skill"),
    created_at: new Date().toISOString(),
    target_runtime: "xiaoba",
    evaluator_runtime: "xiaoba-cli",
    capability_kind: "skill",
    xiaoba: resolved.config,
    cases: caseInput.cases,
    ...(caseInput.casePack && { case_pack: caseInput.casePack }),
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
  const caseInput = resolveCaseInput(options.casePaths, options.casePackPath);
  return {
    schema: "barena.xiaoba_capability_evaluation_request.v1",
    evaluation_id: createEvaluationId("role"),
    created_at: new Date().toISOString(),
    target_runtime: "xiaoba",
    evaluator_runtime: "xiaoba-cli",
    capability_kind: "role",
    xiaoba: resolved.config,
    cases: caseInput.cases,
    ...(caseInput.casePack && { case_pack: caseInput.casePack }),
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
  const passEnv = (options.passEnv ?? DEFAULT_PASS_ENV).map((name) => validateEnvName(name));
  if (new Set(passEnv).size !== passEnv.length) throw new Error("--pass-env names must be unique");
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

export function loadXiaoBaRoleSource(roleId: string, rolesRoot: string): XiaoBaNativeRoleSource {
  const normalized = roleId.trim();
  if (!normalized || normalized === "." || normalized === ".." || !/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error("XiaobaOS Role ID must be a safe path segment and may not be . or ..");
  }
  const sourcePath = path.resolve(rolesRoot, normalized);
  const relative = path.relative(path.resolve(rolesRoot), sourcePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("XiaobaOS Role must stay inside roles root");
  const manifestPath = path.join(sourcePath, "role.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`XiaobaOS Role not found: ${normalized} (${manifestPath})`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { name?: string };
  if (manifest.name !== normalized) {
    throw new Error(`XiaobaOS Role manifest name ${String(manifest.name)} does not match requested ID ${normalized}`);
  }
  return { role_id: normalized, source_path: sourcePath, fingerprint: hashDirectory(sourcePath) };
}

function resolveNativeInputs(options: XiaoBaNativeInputOptions): {
  config: XiaoBaNativeRuntimeConfig;
  rolesRoot: string;
} {
  return createXiaoBaNativeRuntimeConfig(options);
}

function resolveCaseInput(
  casePaths: string[] | undefined,
  casePackPath: string | undefined
): {
  cases: XiaoBaNativeCaseV1[];
  casePack?: ReturnType<typeof loadXiaoBaCasePack>["reference"];
} {
  const paths = casePaths ?? [];
  if (casePackPath && paths.length > 0) throw new Error("Use either casePaths or casePackPath, not both");
  if (casePackPath) {
    const pack = loadXiaoBaCasePack(casePackPath);
    return { cases: pack.cases, casePack: pack.reference };
  }
  if (paths.length === 0) throw new Error("At least one XiaobaOS native case or case pack is required");
  return { cases: paths.map(loadXiaoBaNativeCase) };
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
