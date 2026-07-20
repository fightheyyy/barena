import fs from "node:fs";
import path from "node:path";
import { StaticScanFinding, StaticScanReport } from "../domain/types";
import { writeJson } from "../utils/fs";

const MAX_FILE_BYTES = 256 * 1024;

const RULES: Array<{
  rule_id: string;
  severity: StaticScanFinding["severity"];
  pattern: RegExp;
  summary: string;
}> = [
  {
    rule_id: "destructive-shell",
    severity: "unsafe",
    pattern: /\brm\s+-rf\b|\bdd\s+if=|\bmkfs\b|\bshutdown\b|\breboot\b/i,
    summary: "Potentially destructive shell command appears in subject files.",
  },
  {
    rule_id: "external-side-effect",
    severity: "blocking",
    pattern: /\bsend_text\s*\(|\bmail\s+send\b|\bcalendar\s+create\b|\bim\s+\+messages-send\b/i,
    summary: "Subject appears to request external side effects.",
  },
  {
    rule_id: "secret-reference",
    severity: "warning",
    pattern: /OPENAI_API_KEY|ANTHROPIC_API_KEY|SECRET|TOKEN|PASSWORD/i,
    summary: "Subject references secrets or credentials.",
  },
  {
    rule_id: "network-fetch",
    severity: "warning",
    pattern: /\bcurl\s+|\bwget\s+|fetch\s*\(|axios\./i,
    summary: "Subject appears to use network access.",
  },
  {
    rule_id: "barena-unsafe-marker",
    severity: "unsafe",
    pattern: /BARENA_UNSAFE/i,
    summary: "Subject contains the Barena unsafe test marker.",
  },
];

export function scanSubjectDirectory(subjectId: string, subjectRoot: string, outputPath?: string): StaticScanReport {
  const absoluteRoot = path.resolve(subjectRoot);
  const generatedAt = new Date().toISOString();
  if (!fs.existsSync(absoluteRoot)) {
    return persistReport(outputPath, {
      subject_id: subjectId,
      generated_at: generatedAt,
      decision: "blocked",
      findings: [{
        finding_id: "scan-root-missing.1",
        severity: "blocking",
        rule_id: "scan-root-missing",
        summary: `Static scan root does not exist: ${absoluteRoot}`,
        evidence: [],
      }],
      scanned_files: [],
    });
  }

  const rootStat = fs.lstatSync(absoluteRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return persistReport(outputPath, {
      subject_id: subjectId,
      generated_at: generatedAt,
      decision: "blocked",
      findings: [{
        finding_id: "scan-root-unsafe.1",
        severity: "blocking",
        rule_id: "scan-root-unsafe",
        summary: `Static scan root must be a real directory: ${absoluteRoot}`,
        evidence: [],
      }],
      scanned_files: [],
    });
  }

  let scannedFiles: string[];
  try {
    scannedFiles = listFiles(absoluteRoot, fs.realpathSync(absoluteRoot));
  } catch (error) {
    return persistReport(outputPath, {
      subject_id: subjectId,
      generated_at: generatedAt,
      decision: "blocked",
      findings: [{
        finding_id: "scan-entry-unsafe.1",
        severity: "blocking",
        rule_id: "scan-entry-unsafe",
        summary: error instanceof Error ? error.message : String(error),
        evidence: [],
      }],
      scanned_files: [],
    });
  }
  const findings: StaticScanFinding[] = [];

  for (const filePath of scannedFiles) {
    const relativePath = path.relative(absoluteRoot, filePath);
    const stat = fs.statSync(filePath);
    const content = stat.size > MAX_FILE_BYTES ? "" : fs.readFileSync(filePath, "utf8");
    const scannedText = `${relativePath}\n${content}`;
    for (const rule of RULES) {
      if (rule.pattern.test(scannedText)) {
        findings.push({
          finding_id: `${rule.rule_id}.${findings.length + 1}`,
          severity: rule.severity,
          rule_id: rule.rule_id,
          summary: rule.summary,
          evidence: [relativePath],
        });
      }
    }
    if (stat.size > MAX_FILE_BYTES) {
      findings.push({
        finding_id: `large-file.${findings.length + 1}`,
        severity: "warning",
        rule_id: "large-file",
        summary: "Large file content skipped by scanner; its retained path name was scanned.",
        evidence: [relativePath],
      });
    }
  }

  const unsafeCount = findings.filter((finding) => finding.severity === "unsafe").length;
  const blockingCount = findings.filter((finding) => finding.severity === "blocking").length;
  const warningCount = findings.filter((finding) => finding.severity === "warning").length;
  return persistReport(outputPath, {
    subject_id: subjectId,
    generated_at: generatedAt,
    decision: unsafeCount ? "unsafe" : blockingCount ? "blocked" : warningCount ? "review_required" : "pass",
    findings,
    scanned_files: scannedFiles.map((filePath) => path.relative(absoluteRoot, filePath)),
  });
}

function persistReport(outputPath: string | undefined, report: StaticScanReport): StaticScanReport {
  if (outputPath) writeJson(outputPath, report);
  return report;
}

function listFiles(root: string, realRoot: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if ([".git", "node_modules", "dist", "output", "logs", ".env"].includes(entry.name)) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Static scan input may not contain symlinks: ${fullPath}`);
    const realPath = fs.realpathSync(fullPath);
    const relative = path.relative(realRoot, realPath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Static scan entry resolves outside the scan root: ${fullPath}`);
    }
    if (entry.isDirectory()) files.push(...listFiles(fullPath, realRoot));
    else if (entry.isFile()) files.push(fullPath);
    else throw new Error(`Static scan input contains a non-regular entry: ${fullPath}`);
  }
  return files.sort();
}
