import fs from "node:fs";
import path from "node:path";

const SECRET_NAME = /(API_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i;

export function xiaobaProjectDotenvPath(
  projectRoot: string | undefined
): string | undefined {
  if (!projectRoot) return undefined;
  const candidate = path.join(projectRoot, ".env");
  try {
    const stat = fs.lstatSync(candidate);
    return stat.isFile() && !stat.isSymbolicLink() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function readXiaobaProjectSecretValues(
  projectRoot: string | undefined
): string[] {
  const dotenvPath = xiaobaProjectDotenvPath(projectRoot);
  if (!dotenvPath) return [];
  const secrets: string[] = [];
  for (const rawLine of fs.readFileSync(dotenvPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || !SECRET_NAME.test(match[1])) continue;
    const value = parseDotenvValue(match[2]);
    if (value) secrets.push(value);
  }
  return [...new Set(secrets)];
}

function parseDotenvValue(raw: string): string {
  const value = raw.trim();
  if (
    value.length >= 2 &&
    (value.startsWith("\"") && value.endsWith("\"") ||
      value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  const comment = value.indexOf(" #");
  return (comment >= 0 ? value.slice(0, comment) : value).trim();
}
