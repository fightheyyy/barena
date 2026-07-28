import fs from "node:fs";
import path from "node:path";

export type KnownRuntimeId =
  | "xiaobaos"
  | "openclaw"
  | "claude-code"
  | "codex"
  | "hermes";

export interface LocalRuntimeDescriptor {
  id: KnownRuntimeId;
  display_name: string;
  command_name: string;
  command_path?: string;
  installed: boolean;
  explore_support: "ready" | "pending";
  detail: string;
}

export interface XiaobaInstallation {
  command: string;
  command_path?: string;
  project_root?: string;
  roles_root?: string;
  skills_root?: string;
}

export interface XiaobaRoleDescriptor {
  id: string;
  display_name: string;
  description?: string;
  aliases?: string[];
  path: string;
  evaluator_role: boolean;
  base_profile?: boolean;
}

export interface XiaobaSkillDescriptor {
  id: string;
  display_name: string;
  description?: string;
  path: string;
  scope: "base" | "role";
  role_id?: string;
}

const RUNTIMES: Array<{
  id: KnownRuntimeId;
  displayName: string;
  command: string;
  exploreSupport: "ready" | "pending";
}> = [
  { id: "xiaobaos", displayName: "XiaoBaOS", command: "xiaoba", exploreSupport: "ready" },
  { id: "openclaw", displayName: "OpenClaw", command: "openclaw", exploreSupport: "pending" },
  { id: "claude-code", displayName: "Claude Code", command: "claude", exploreSupport: "pending" },
  { id: "codex", displayName: "Codex", command: "codex", exploreSupport: "pending" },
  { id: "hermes", displayName: "Hermes", command: "hermes", exploreSupport: "pending" },
];

const EVALUATOR_ROLES = new Set(["user-cat", "inspector-cat", "reviewer-cat"]);
const BASE_ROLE_IDS = new Set(["base", "default", "none"]);

export function discoverLocalRuntimes(
  env: NodeJS.ProcessEnv = process.env
): LocalRuntimeDescriptor[] {
  return RUNTIMES.map((runtime) => {
    const commandPath = resolveCommandOnPath(runtime.command, env.PATH);
    const installed = Boolean(commandPath);
    const support = runtime.exploreSupport;
    return {
      id: runtime.id,
      display_name: runtime.displayName,
      command_name: runtime.command,
      ...(commandPath && { command_path: commandPath }),
      installed,
      explore_support: support,
      detail: !installed
        ? "not installed on PATH"
        : support === "ready"
          ? "installed; Explore adapter available"
          : "installed; Explore adapter pending",
    };
  });
}

export function resolveXiaobaInstallation(input: {
  command?: string;
  project_root?: string;
  roles_root?: string;
  skills_root?: string;
  env?: NodeJS.ProcessEnv;
} = {}): XiaobaInstallation {
  const env = input.env ?? process.env;
  const command = input.command ?? "xiaoba";
  const commandPath = resolveExecutable(command, env.PATH);
  const explicitProject = input.project_root ?? env.XIAOBA_PROJECT_ROOT;
  const inferredProject = explicitProject
    ? path.resolve(explicitProject)
    : commandPath
      ? findXiaobaProjectRoot(commandPath)
      : undefined;
  const projectRoot = inferredProject && isDirectory(inferredProject) ? inferredProject : undefined;
  const rolesCandidate =
    input.roles_root ??
    env.XIAOBA_ROLES_ROOT ??
    (projectRoot ? path.join(projectRoot, "roles") : undefined);
  const skillsCandidate =
    input.skills_root ??
    env.XIAOBA_SKILLS_ROOT ??
    (projectRoot ? path.join(projectRoot, "skills") : undefined);
  return {
    command: commandPath ?? command,
    ...(commandPath && { command_path: commandPath }),
    ...(projectRoot && { project_root: projectRoot }),
    ...(rolesCandidate && isDirectory(path.resolve(rolesCandidate))
      ? { roles_root: path.resolve(rolesCandidate) }
      : {}),
    ...(skillsCandidate && isDirectory(path.resolve(skillsCandidate))
      ? { skills_root: path.resolve(skillsCandidate) }
      : {}),
  };
}

export function listXiaobaRoles(
  rolesRoot: string,
  options: { include_evaluators?: boolean } = {}
): XiaobaRoleDescriptor[] {
  const absoluteRoot = path.resolve(rolesRoot);
  if (!isDirectory(absoluteRoot)) {
    throw new Error(`XiaoBaOS roles root is not a directory: ${absoluteRoot}`);
  }
  const roles: XiaobaRoleDescriptor[] = [];
  for (const entry of fs.readdirSync(absoluteRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const rolePath = path.join(absoluteRoot, entry.name);
    const manifestPath = path.join(rolePath, "role.json");
    if (!isRegularFile(manifestPath)) continue;
    let manifest: Record<string, unknown>;
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      manifest = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (manifest.status === "blocked") continue;
    const id =
      typeof manifest.name === "string" && isSafeId(manifest.name)
        ? manifest.name
        : entry.name;
    const evaluatorRole = EVALUATOR_ROLES.has(normalizeRoleId(id));
    if (evaluatorRole && !options.include_evaluators) continue;
    roles.push({
      id,
      display_name:
        typeof manifest.displayName === "string" && manifest.displayName.trim()
          ? manifest.displayName.trim()
          : id,
      ...(typeof manifest.description === "string" && manifest.description.trim()
        ? { description: manifest.description.trim() }
        : {}),
      ...(Array.isArray(manifest.aliases)
        ? {
            aliases: manifest.aliases
              .filter(
                (alias): alias is string =>
                  typeof alias === "string" && Boolean(alias.trim())
              )
              .map((alias) => alias.trim())
              .slice(0, 100),
          }
        : {}),
      path: rolePath,
      evaluator_role: evaluatorRole,
    });
  }
  return roles.sort(
    (left, right) =>
      left.display_name.localeCompare(right.display_name) || left.id.localeCompare(right.id)
  );
}

export function listXiaobaTargetProfiles(
  rolesRoot: string
): XiaobaRoleDescriptor[] {
  return [xiaobaBaseProfile(rolesRoot), ...listXiaobaRoles(rolesRoot)];
}

export function listXiaobaSkills(
  skillsRoot: string | undefined,
  roles: XiaobaRoleDescriptor[] = []
): XiaobaSkillDescriptor[] {
  const skills = [
    ...(skillsRoot && isDirectory(path.resolve(skillsRoot))
      ? scanSkillDirectory(path.resolve(skillsRoot), "base")
      : []),
    ...roles.flatMap((role) => {
      if (role.base_profile) return [];
      const roleSkills = path.join(role.path, "skills");
      return isDirectory(roleSkills)
        ? scanSkillDirectory(roleSkills, "role", role.id)
        : [];
    }),
  ];
  return skills.sort(
    (left, right) =>
      left.display_name.localeCompare(right.display_name) ||
      left.id.localeCompare(right.id)
  );
}

export function resolveXiaobaRole(
  rolesRoot: string,
  requestedRole: string
): XiaobaRoleDescriptor | undefined {
  const normalized = normalizeRoleId(requestedRole);
  if (BASE_ROLE_IDS.has(normalized)) return xiaobaBaseProfile(rolesRoot);
  return listXiaobaRoles(rolesRoot, { include_evaluators: true }).find(
    (role) => normalizeRoleId(role.id) === normalized
  );
}

function xiaobaBaseProfile(rolesRoot: string): XiaobaRoleDescriptor {
  return {
    id: "base",
    display_name: "Base Agent",
    description: "XiaoBaOS default Agent without an active Role.",
    aliases: ["default", "none"],
    path: path.resolve(rolesRoot),
    evaluator_role: false,
    base_profile: true,
  };
}

function scanSkillDirectory(
  root: string,
  scope: XiaobaSkillDescriptor["scope"],
  roleId?: string
): XiaobaSkillDescriptor[] {
  const skills: XiaobaSkillDescriptor[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const skillPath = path.join(root, entry.name);
    const manifestPath = path.join(skillPath, "SKILL.md");
    if (!isRegularFile(manifestPath)) continue;
    let manifest: string;
    try {
      manifest = fs.readFileSync(manifestPath, "utf8");
    } catch {
      continue;
    }
    const frontmatter = manifest.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)?.[1];
    const declaredName = frontmatter
      ? yamlScalar(frontmatter, "name")
      : undefined;
    const id =
      declaredName && isSafeId(declaredName) ? declaredName : entry.name;
    if (!isSafeId(id)) continue;
    const description = frontmatter
      ? yamlScalar(frontmatter, "description")
      : undefined;
    skills.push({
      id,
      display_name: id,
      ...(description && { description }),
      path: skillPath,
      scope,
      ...(roleId && { role_id: roleId }),
    });
  }
  return skills;
}

function yamlScalar(frontmatter: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const raw = frontmatter
    .match(new RegExp(`^${escaped}:\\s*(.*?)\\s*$`, "m"))?.[1]
    ?.trim();
  if (!raw) return undefined;
  return raw.replace(/^["']|["']$/g, "").trim() || undefined;
}

export function resolveCommandOnPath(
  command: string,
  pathValue: string | undefined = process.env.PATH
): string | undefined {
  for (const entry of (pathValue ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, command);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function resolveExecutable(command: string, pathValue: string | undefined): string | undefined {
  if (command.includes(path.sep)) {
    const absolute = path.resolve(command);
    return isExecutable(absolute) ? absolute : undefined;
  }
  return resolveCommandOnPath(command, pathValue);
}

function findXiaobaProjectRoot(commandPath: string): string | undefined {
  let current: string;
  try {
    current = path.dirname(fs.realpathSync(commandPath));
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < 8; depth += 1) {
    if (isDirectory(path.join(current, "roles")) && isRegularFile(path.join(current, "package.json"))) {
      try {
        const metadata = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8")) as {
          name?: unknown;
        };
        if (metadata.name === "xiaoba-cli" || metadata.name === "xiaoba") return current;
      } catch {
        // Continue walking; the directory may still be inside the real package.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function normalizeRoleId(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(candidate: string): boolean {
  try {
    const stat = fs.lstatSync(candidate);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
