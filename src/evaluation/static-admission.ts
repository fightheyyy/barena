import fs from "node:fs";
import path from "node:path";
import type { StaticScanFinding, StaticScanReport } from "../domain/types";
import { scanSubjectDirectory } from "../subjects/scanner";
import { copyDirectory, ensureDir, hashDirectory, writeJson } from "../utils/fs";

export type StaticAdmissionRelation = "baseline" | "common" | "candidate";
export type StaticAdmissionSubjectKind = "role" | "skill";
export type StaticAdmissionDecision = "pass" | "held" | "rejected";
export type StaticAdmissionReasonCode =
  | "static_admission_passed"
  | "static_admission_candidate_unsafe"
  | "static_admission_candidate_blocked"
  | "static_admission_baseline_unsafe"
  | "static_admission_baseline_blocked"
  | "static_admission_common_unsafe"
  | "static_admission_common_blocked"
  | "static_admission_review_required"
  | "static_admission_snapshot_failed";

export interface StaticAdmissionSubjectInput {
  relation: StaticAdmissionRelation;
  subject_kind: StaticAdmissionSubjectKind;
  subject_id: string;
  source_path: string;
  fingerprint: string;
}

export interface PreparedStaticAdmissionSubject extends StaticAdmissionSubjectInput {
  snapshot_path: string;
  scan_ref: string;
  scan: StaticScanReport;
}

export interface StaticAdmissionSubjectReport {
  relation: StaticAdmissionRelation;
  subject_kind: StaticAdmissionSubjectKind;
  subject_id: string;
  fingerprint: string;
  snapshot_ref: string;
  scan_ref: string;
  scan: StaticScanReport;
}

export interface StaticAdmissionReportV1 {
  schema: "barena.static_admission.v1";
  generated_at: string;
  decision: StaticAdmissionDecision;
  reason_code: StaticAdmissionReasonCode;
  summary: string;
  report_ref: string;
  accepted_finding_ids: string[];
  unaccepted_finding_ids: string[];
  evidence_complete: boolean;
  evidence_refs: string[];
  subjects: StaticAdmissionSubjectReport[];
}

export interface PrepareStaticAdmissionInput {
  evaluation_root: string;
  subjects: StaticAdmissionSubjectInput[];
  accepted_finding_ids?: string[];
  now?: () => Date;
}

export interface PreparedStaticAdmission {
  report: StaticAdmissionReportV1;
  subjects: PreparedStaticAdmissionSubject[];
}

export function prepareStaticAdmission(input: PrepareStaticAdmissionInput): PreparedStaticAdmission {
  const evaluationRoot = path.resolve(input.evaluation_root);
  const admissionRoot = path.join(evaluationRoot, "preflight", "admission");
  const reportRef = path.join(admissionRoot, "admission.json");
  const acceptedFindingIds = [...new Set(input.accepted_finding_ids ?? [])].sort();
  const prepared: PreparedStaticAdmissionSubject[] = [];
  const subjectReports: StaticAdmissionSubjectReport[] = [];
  let snapshotError: string | undefined;

  ensureDir(admissionRoot);
  validateSubjects(input.subjects);

  for (const [index, subject] of input.subjects.entries()) {
    const snapshotPath = snapshotPathFor(evaluationRoot, subject);
    const scanRef = path.join(
      admissionRoot,
      `${String(index + 1).padStart(2, "0")}-${safeSegment(subject.relation)}-${safeSegment(subject.subject_kind)}-${safeSegment(subject.subject_id)}.json`
    );
    try {
      stageImmutableSnapshot(subject, snapshotPath);
      const rawScan = scanSubjectDirectory(subject.subject_id, snapshotPath);
      const scan = namespaceFindings(rawScan, subject);
      writeJson(scanRef, scan);
      prepared.push({ ...subject, snapshot_path: snapshotPath, scan_ref: scanRef, scan });
      subjectReports.push({
        relation: subject.relation,
        subject_kind: subject.subject_kind,
        subject_id: subject.subject_id,
        fingerprint: subject.fingerprint,
        snapshot_ref: snapshotPath,
        scan_ref: scanRef,
        scan,
      });
    } catch (error) {
      snapshotError = error instanceof Error ? error.message : String(error);
      const scan = snapshotFailureScan(subject, snapshotError, input.now?.() ?? new Date());
      writeJson(scanRef, scan);
      subjectReports.push({
        relation: subject.relation,
        subject_kind: subject.subject_kind,
        subject_id: subject.subject_id,
        fingerprint: subject.fingerprint,
        snapshot_ref: snapshotPath,
        scan_ref: scanRef,
        scan,
      });
      break;
    }
  }

  const unacceptedFindingIds = subjectReports
    .flatMap((subject) => subject.scan.findings)
    .filter((finding) => finding.severity === "warning" && !acceptedFindingIds.includes(finding.finding_id))
    .map((finding) => finding.finding_id)
    .sort();
  const verdict = decideAdmission(subjectReports, unacceptedFindingIds, snapshotError);
  const evidenceRefs = [reportRef, ...subjectReports.map((subject) => subject.scan_ref)];
  const evidenceComplete = snapshotError === undefined && subjectReports.length === input.subjects.length;
  const report: StaticAdmissionReportV1 = {
    schema: "barena.static_admission.v1",
    generated_at: (input.now?.() ?? new Date()).toISOString(),
    decision: verdict.decision,
    reason_code: verdict.reason_code,
    summary: verdict.summary,
    report_ref: reportRef,
    accepted_finding_ids: acceptedFindingIds,
    unaccepted_finding_ids: unacceptedFindingIds,
    evidence_complete: evidenceComplete,
    evidence_refs: evidenceRefs,
    subjects: subjectReports,
  };
  writeJson(reportRef, report);
  return { report, subjects: prepared };
}

function stageImmutableSnapshot(subject: StaticAdmissionSubjectInput, destination: string): void {
  const source = path.resolve(subject.source_path);
  if (!fs.existsSync(source)) {
    throw new Error(`${label(subject)} source is not a directory: ${source}`);
  }
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`${label(subject)} source may not be a symlink: ${source}`);
  }
  if (!sourceStat.isDirectory()) {
    throw new Error(`${label(subject)} source is not a directory: ${source}`);
  }
  assertNoUnsafeEntries(source);
  if (hashDirectory(source) !== subject.fingerprint) {
    throw new Error(`${label(subject)} source fingerprint changed before admission.`);
  }
  copyDirectory(source, destination);
  if (hashDirectory(destination) !== subject.fingerprint) {
    throw new Error(`${label(subject)} immutable snapshot fingerprint differs.`);
  }
  makeReadOnly(destination);
}

function namespaceFindings(
  report: StaticScanReport,
  subject: StaticAdmissionSubjectInput
): StaticScanReport {
  const prefix = `${subject.relation}.${subject.subject_kind}.${safeSegment(subject.subject_id)}`;
  return {
    ...report,
    subject_id: `${subject.relation}.${subject.subject_kind}.${subject.subject_id}`,
    findings: report.findings.map((finding) => ({
      ...finding,
      finding_id: `${prefix}.${finding.finding_id}`,
    })),
  };
}

function snapshotFailureScan(
  subject: StaticAdmissionSubjectInput,
  detail: string,
  now: Date
): StaticScanReport {
  const finding: StaticScanFinding = {
    finding_id: `${subject.relation}.${subject.subject_kind}.${safeSegment(subject.subject_id)}.snapshot-failed.1`,
    severity: "blocking",
    rule_id: "snapshot-failed",
    summary: detail,
    evidence: [],
  };
  return {
    subject_id: `${subject.relation}.${subject.subject_kind}.${subject.subject_id}`,
    generated_at: now.toISOString(),
    decision: "blocked",
    findings: [finding],
    scanned_files: [],
  };
}

function decideAdmission(
  subjects: StaticAdmissionSubjectReport[],
  unacceptedFindingIds: string[],
  snapshotError: string | undefined
): { decision: StaticAdmissionDecision; reason_code: StaticAdmissionReasonCode; summary: string } {
  if (snapshotError) {
    return {
      decision: "held",
      reason_code: "static_admission_snapshot_failed",
      summary: `Static admission could not create and scan every immutable input snapshot. ${snapshotError}`,
    };
  }

  for (const relation of ["common", "baseline"] as const) {
    const unsafe = subjects.find((subject) => subject.relation === relation && subject.scan.decision === "unsafe");
    if (unsafe) {
      return {
        decision: "held",
        reason_code: relation === "common" ? "static_admission_common_unsafe" : "static_admission_baseline_unsafe",
        summary: `${capitalize(relation)} ${unsafe.subject_kind} ${unsafe.subject_id} contains an unsafe static finding; the paired baseline is not trustworthy.`,
      };
    }
    const blocked = subjects.find((subject) => subject.relation === relation && subject.scan.decision === "blocked");
    if (blocked) {
      return {
        decision: "held",
        reason_code: relation === "common" ? "static_admission_common_blocked" : "static_admission_baseline_blocked",
        summary: `${capitalize(relation)} ${blocked.subject_kind} ${blocked.subject_id} contains a blocking static finding; the paired baseline is not trustworthy.`,
      };
    }
  }

  const candidateUnsafe = subjects.find(
    (subject) => subject.relation === "candidate" && subject.scan.decision === "unsafe"
  );
  if (candidateUnsafe) {
    return {
      decision: "rejected",
      reason_code: "static_admission_candidate_unsafe",
      summary: `Candidate ${candidateUnsafe.subject_kind} ${candidateUnsafe.subject_id} contains an unsafe static finding.`,
    };
  }
  const candidateBlocked = subjects.find(
    (subject) => subject.relation === "candidate" && subject.scan.decision === "blocked"
  );
  if (candidateBlocked) {
    return {
      decision: "held",
      reason_code: "static_admission_candidate_blocked",
      summary: `Candidate ${candidateBlocked.subject_kind} ${candidateBlocked.subject_id} contains a blocking static finding.`,
    };
  }
  if (unacceptedFindingIds.length > 0) {
    return {
      decision: "held",
      reason_code: "static_admission_review_required",
      summary: `Static admission requires explicit acceptance of finding IDs: ${unacceptedFindingIds.join(", ")}.`,
    };
  }
  return {
    decision: "pass",
    reason_code: "static_admission_passed",
    summary: "All immutable paired inputs passed static admission or had every review finding explicitly accepted.",
  };
}

function snapshotPathFor(root: string, subject: StaticAdmissionSubjectInput): string {
  return path.join(
    root,
    "inputs",
    subject.relation,
    `${subject.subject_kind}s`,
    safeSegment(subject.subject_id)
  );
}

function validateSubjects(subjects: StaticAdmissionSubjectInput[]): void {
  if (subjects.length === 0) throw new Error("Static admission requires at least one subject input.");
  const keys = new Set<string>();
  for (const subject of subjects) {
    if (
      subject.subject_id === "." ||
      subject.subject_id === ".." ||
      !/^[A-Za-z0-9._-]+$/.test(subject.subject_id)
    ) {
      throw new Error(`Static admission subject_id is unsafe or contains a dot segment: ${subject.subject_id}`);
    }
    if (!/^[a-f0-9]{64}$/i.test(subject.fingerprint)) {
      throw new Error(`Static admission fingerprint is invalid for ${subject.subject_id}.`);
    }
    const key = `${subject.relation}:${subject.subject_kind}:${subject.subject_id}`;
    if (keys.has(key)) throw new Error(`Duplicate static admission subject: ${key}`);
    keys.add(key);
  }
}

function assertNoUnsafeEntries(root: string): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", "output", "logs"].includes(entry.name)) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.name === ".env") throw new Error(`Static admission input may not contain .env: ${fullPath}`);
    if (entry.isSymbolicLink()) throw new Error(`Static admission input may not contain symlinks: ${fullPath}`);
    if (entry.isDirectory()) assertNoUnsafeEntries(fullPath);
    else if (!entry.isFile()) throw new Error(`Static admission input contains a non-regular entry: ${fullPath}`);
  }
}

function makeReadOnly(root: string): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      makeReadOnly(fullPath);
    } else if (entry.isFile()) {
      const mode = fs.statSync(fullPath).mode & 0o777;
      fs.chmodSync(fullPath, 0o444 | (mode & 0o111));
    }
  }
  fs.chmodSync(root, 0o555);
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

function label(subject: StaticAdmissionSubjectInput): string {
  return `${capitalize(subject.relation)} ${subject.subject_kind} ${subject.subject_id}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
