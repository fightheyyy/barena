import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "../utils/fs";

const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const PROJECT_CONFIG_SCHEMA = "barena.project_config.v1" as const;
export const DEFAULT_PROJECT_CONFIG = path.join(".barena", "config.json");
export const DEFAULT_STARTER_SUITE = "skillsbench:starter";

export interface BarenaProviderProfile {
  provider: string;
  model: string;
  credential_env: string;
  api_base_env?: string;
}

export type BarenaTargetProfile =
  | {
      kind: "openclaw";
      command: string;
      agent: string;
      env_allowlist: string[];
    }
  | {
      kind: "xiaobaos";
      command: string;
      role?: string;
      live_policy?: string;
      env_allowlist: string[];
    }
  | {
      kind: "portable";
      runtime: string;
      command: string;
      agent?: string;
      env_allowlist: string[];
    };

export interface BarenaProjectConfigV1 {
  schema: typeof PROJECT_CONFIG_SCHEMA;
  default_target: string;
  targets: Record<string, BarenaTargetProfile>;
  provider?: BarenaProviderProfile;
  defaults: {
    suite: string;
    attempts: number;
    subjects_root: string;
    runs_root: string;
  };
}

export interface LoadedProjectConfig {
  path: string;
  root: string;
  config: BarenaProjectConfigV1;
}

export interface InitializeProjectConfigOptions {
  cwd?: string;
  configPath?: string;
  target?: string;
  targetCommand?: string;
  agent?: string;
  role?: string;
  livePolicy?: string;
  envAllowlist?: string[];
  provider?: string;
  model?: string;
  credentialEnv?: string;
  apiBaseEnv?: string;
  suite?: string;
  attempts?: number;
  subjectsRoot?: string;
  runsRoot?: string;
  force?: boolean;
  commandAvailable?: (command: string) => boolean;
}

export interface InitializedProjectConfig {
  config_path: string;
  project_root: string;
  detected_target: boolean;
  config: BarenaProjectConfigV1;
  next_commands: string[];
}

export function initializeProjectConfig(options: InitializeProjectConfigOptions = {}): InitializedProjectConfig {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const configPath = path.resolve(cwd, options.configPath ?? DEFAULT_PROJECT_CONFIG);
  const configDirectory = path.dirname(configPath);
  const projectRoot = path.basename(configDirectory) === ".barena" ? path.dirname(configDirectory) : cwd;
  if (fs.existsSync(configPath) && !options.force) {
    throw new Error(`Barena project config already exists: ${configPath}. Use --force to replace it.`);
  }

  const commandAvailable = options.commandAvailable ?? commandExists;
  const selected = selectTarget(options.target, commandAvailable);
  const targetId = selected.target;
  const envAllowlist = uniqueEnvNames([
    ...(options.envAllowlist ?? []),
    ...(options.credentialEnv ? [options.credentialEnv] : []),
    ...(options.apiBaseEnv ? [options.apiBaseEnv] : []),
  ]);
  const target = createTargetProfile(targetId, options, envAllowlist);
  const provider = createProviderProfile(options);
  const attempts = options.attempts ?? 3;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 11) {
    throw new Error("Project default attempts must be an integer from 1 to 11");
  }
  const suite = requiredText(options.suite ?? DEFAULT_STARTER_SUITE, "suite");
  const config: BarenaProjectConfigV1 = {
    schema: PROJECT_CONFIG_SCHEMA,
    default_target: targetId,
    targets: { [targetId]: target },
    ...(provider && { provider }),
    defaults: {
      suite,
      attempts,
      subjects_root: safeRelativeRoot(options.subjectsRoot ?? "subjects", "subjects root"),
      runs_root: safeRelativeRoot(options.runsRoot ?? "runs", "runs root"),
    },
  };
  validateProjectConfig(config);
  writeJson(configPath, config);
  fs.chmodSync(configPath, 0o600);
  return {
    config_path: configPath,
    project_root: projectRoot,
    detected_target: selected.detected,
    config,
    next_commands: [
      "barena doctor",
      "barena eval skill <skill-directory>",
    ],
  };
}

export function loadProjectConfig(cwd = process.cwd(), explicitPath?: string): LoadedProjectConfig | undefined {
  const requestedRoot = path.resolve(cwd);
  const configPath = explicitPath
    ? path.resolve(requestedRoot, explicitPath)
    : findProjectConfigPath(requestedRoot);
  if (!configPath) return undefined;
  if (!fs.existsSync(configPath)) {
    throw new Error(`Barena project config does not exist: ${configPath}`);
  }
  if (!fs.statSync(configPath).isFile()) throw new Error(`Barena project config must be a file: ${configPath}`);
  const config = validateProjectConfig(readJson<unknown>(configPath));
  const configDirectory = path.dirname(configPath);
  const root = path.basename(configDirectory) === ".barena" ? path.dirname(configDirectory) : requestedRoot;
  return { path: configPath, root, config };
}

export function validateProjectConfig(value: unknown): BarenaProjectConfigV1 {
  const root = record(value, "project config");
  exactKeys(root, ["schema", "default_target", "targets", "provider", "defaults"], "project config");
  if (root.schema !== PROJECT_CONFIG_SCHEMA) throw new Error(`Project config schema must be ${PROJECT_CONFIG_SCHEMA}`);
  const defaultTarget = safeId(root.default_target, "project config default_target");
  const targetValues = record(root.targets, "project config targets");
  const targets: Record<string, BarenaTargetProfile> = {};
  for (const [id, profile] of Object.entries(targetValues)) {
    const targetId = safeId(id, "project config target id");
    targets[targetId] = validateTargetProfile(profile, targetId);
  }
  if (!targets[defaultTarget]) throw new Error(`Project config default target is not defined: ${defaultTarget}`);

  const defaultsValue = record(root.defaults, "project config defaults");
  exactKeys(defaultsValue, ["suite", "attempts", "subjects_root", "runs_root"], "project config defaults");
  const attempts = positiveInteger(defaultsValue.attempts, "project config defaults.attempts");
  if (attempts > 11) throw new Error("Project config defaults.attempts must be at most 11");
  const provider = root.provider === undefined ? undefined : validateProviderProfile(root.provider);
  return {
    schema: PROJECT_CONFIG_SCHEMA,
    default_target: defaultTarget,
    targets,
    ...(provider && { provider }),
    defaults: {
      suite: requiredText(defaultsValue.suite, "project config defaults.suite"),
      attempts,
      subjects_root: safeRelativeRoot(defaultsValue.subjects_root, "project config defaults.subjects_root"),
      runs_root: safeRelativeRoot(defaultsValue.runs_root, "project config defaults.runs_root"),
    },
  };
}

export function targetProfile(config: BarenaProjectConfigV1, targetId?: string): { id: string; profile: BarenaTargetProfile } {
  const id = safeId(targetId ?? config.default_target, "target id");
  const profile = config.targets[id];
  if (!profile) throw new Error(`Target ${id} is not configured in the Barena project`);
  return { id, profile };
}

export function resolveConfigReference(loaded: LoadedProjectConfig, value: string): string {
  if (!value.includes(path.sep) && !value.startsWith(".")) return value;
  return path.resolve(loaded.root, value);
}

export function providerReadiness(
  provider: BarenaProviderProfile | undefined,
  environment: NodeJS.ProcessEnv = process.env
): Record<string, unknown> & { status: "ready" | "blocked" | "unmanaged" } {
  if (!provider) {
    return {
      status: "unmanaged",
      detail: "Target Agent owns provider authentication; no Barena provider environment references are configured.",
    };
  }
  const names = [provider.credential_env, ...(provider.api_base_env ? [provider.api_base_env] : [])];
  const missing = names.filter((name) => !environment[name]);
  return {
    status: missing.length ? "blocked" : "ready",
    provider: provider.provider,
    model: provider.model,
    credential_env: provider.credential_env,
    ...(provider.api_base_env && { api_base_env: provider.api_base_env }),
    missing_env: missing,
    detail: missing.length
      ? `Configured environment names are missing: ${missing.join(", ")}.`
      : "Configured provider environment names are present; values were not read into the report.",
  };
}

function createTargetProfile(
  targetId: string,
  options: InitializeProjectConfigOptions,
  envAllowlist: string[]
): BarenaTargetProfile {
  if (targetId === "openclaw") {
    return {
      kind: "openclaw",
      command: requiredText(options.targetCommand ?? "openclaw", "OpenClaw command"),
      agent: requiredText(options.agent ?? "main", "OpenClaw agent"),
      env_allowlist: envAllowlist,
    };
  }
  if (targetId === "xiaobaos" || targetId === "xiaoba") {
    return {
      kind: "xiaobaos",
      command: requiredText(options.targetCommand ?? "xiaoba", "XiaobaOS command"),
      ...(options.role && { role: safeId(options.role, "XiaobaOS Role ID") }),
      ...(options.livePolicy && { live_policy: requiredText(options.livePolicy, "live policy path") }),
      env_allowlist: envAllowlist,
    };
  }
  const command = requiredText(options.targetCommand, `portable target ${targetId} command`);
  return {
    kind: "portable",
    runtime: targetId,
    command,
    ...(options.agent && { agent: requiredText(options.agent, "portable agent") }),
    env_allowlist: envAllowlist,
  };
}

function createProviderProfile(options: InitializeProjectConfigOptions): BarenaProviderProfile | undefined {
  const fields = [options.provider, options.model, options.credentialEnv, options.apiBaseEnv].filter(Boolean).length;
  if (fields === 0) return undefined;
  if (!options.provider || !options.model || !options.credentialEnv) {
    throw new Error("Provider configuration requires --provider, --model, and --api-key-env together");
  }
  return {
    provider: requiredText(options.provider, "provider"),
    model: requiredText(options.model, "model"),
    credential_env: envName(options.credentialEnv, "credential environment"),
    ...(options.apiBaseEnv && { api_base_env: envName(options.apiBaseEnv, "API base environment") }),
  };
}

function validateProviderProfile(value: unknown): BarenaProviderProfile {
  const provider = record(value, "project config provider");
  exactKeys(provider, ["provider", "model", "credential_env", "api_base_env"], "project config provider");
  return {
    provider: requiredText(provider.provider, "project config provider.provider"),
    model: requiredText(provider.model, "project config provider.model"),
    credential_env: envName(provider.credential_env, "project config provider.credential_env"),
    ...(provider.api_base_env !== undefined && {
      api_base_env: envName(provider.api_base_env, "project config provider.api_base_env"),
    }),
  };
}

function validateTargetProfile(value: unknown, targetId: string): BarenaTargetProfile {
  const profile = record(value, `project config target ${targetId}`);
  const kind = requiredText(profile.kind, `project config target ${targetId}.kind`);
  if (kind === "openclaw") {
    exactKeys(profile, ["kind", "command", "agent", "env_allowlist"], `project config target ${targetId}`);
    return {
      kind,
      command: requiredText(profile.command, `project config target ${targetId}.command`),
      agent: requiredText(profile.agent, `project config target ${targetId}.agent`),
      env_allowlist: envNames(profile.env_allowlist, `project config target ${targetId}.env_allowlist`),
    };
  }
  if (kind === "xiaobaos") {
    exactKeys(profile, ["kind", "command", "role", "live_policy", "env_allowlist"], `project config target ${targetId}`);
    return {
      kind,
      command: requiredText(profile.command, `project config target ${targetId}.command`),
      ...(profile.role !== undefined && { role: safeId(profile.role, `project config target ${targetId}.role`) }),
      ...(profile.live_policy !== undefined && { live_policy: requiredText(profile.live_policy, `project config target ${targetId}.live_policy`) }),
      env_allowlist: envNames(profile.env_allowlist, `project config target ${targetId}.env_allowlist`),
    };
  }
  if (kind === "portable") {
    exactKeys(profile, ["kind", "runtime", "command", "agent", "env_allowlist"], `project config target ${targetId}`);
    const runtime = safeId(profile.runtime, `project config target ${targetId}.runtime`);
    if (runtime !== targetId) throw new Error(`Portable target key ${targetId} must match runtime ${runtime}`);
    return {
      kind,
      runtime,
      command: requiredText(profile.command, `project config target ${targetId}.command`),
      ...(profile.agent !== undefined && { agent: requiredText(profile.agent, `project config target ${targetId}.agent`) }),
      env_allowlist: envNames(profile.env_allowlist, `project config target ${targetId}.env_allowlist`),
    };
  }
  throw new Error(`Project config target ${targetId}.kind must be openclaw, xiaobaos, or portable`);
}

function selectTarget(target: string | undefined, available: (command: string) => boolean): { target: string; detected: boolean } {
  if (target) return { target: normalizeTarget(target), detected: false };
  const detected = [
    ...(available("openclaw") ? ["openclaw"] : []),
    ...(available("xiaoba") ? ["xiaobaos"] : []),
  ];
  if (detected.length === 1) return { target: detected[0], detected: true };
  if (detected.length === 0) {
    throw new Error("No supported Agent command was detected. Use --target openclaw, --target xiaobaos, or --target <custom-id> --target-command <driver>.");
  }
  throw new Error(`Multiple Agent commands were detected (${detected.join(", ")}). Select one with --target.`);
}

function normalizeTarget(value: string): string {
  const id = safeId(value, "target");
  return id === "xiaoba" ? "xiaobaos" : id;
}

function findProjectConfigPath(cwd: string): string | undefined {
  let current = cwd;
  while (true) {
    const candidate = path.join(current, DEFAULT_PROJECT_CONFIG);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function commandExists(command: string): boolean {
  for (const entry of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return true;
    } catch {
      // Keep probing PATH.
    }
  }
  return false;
}

function safeRelativeRoot(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (path.isAbsolute(text)) return path.normalize(text);
  const normalized = path.normalize(text);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new Error(`${label} may not escape the project root`);
  return normalized;
}

function uniqueEnvNames(values: string[]): string[] {
  return envNames([...new Set(values)], "environment allowlist");
}

function envNames(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !ENV_NAME.test(entry))) {
    throw new Error(`${label} must contain valid environment-variable names`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} must contain unique names`);
  return value;
}

function envName(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (!ENV_NAME.test(text)) throw new Error(`${label} must be an environment-variable name`);
  return text;
}

function safeId(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (!SAFE_ID.test(text) || text === "." || text === "..") throw new Error(`${label} must be a safe identifier`);
  return text;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`${label} contains unsupported fields: ${extra.join(", ")}`);
}
