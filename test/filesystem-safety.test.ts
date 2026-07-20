import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadAgentE2ECase } from "../src/e2e/case-runner";
import { prepareStaticAdmission } from "../src/evaluation/static-admission";
import { loadXiaoBaNativeCase } from "../src/evaluation/xiaoba-native-input";
import { importLocalSkill, loadSubjectManifest } from "../src/subjects/importer";
import { scanSubjectDirectory } from "../src/subjects/scanner";
import { hashDirectory } from "../src/utils/fs";

test("subject IDs reject dot segments without touching an ancestor directory", () => {
  const root = tempRoot("barena-subject-dot-segment-");
  const source = path.join(root, "source");
  const storage = path.join(root, "storage");
  const subjectsRoot = path.join(storage, "subjects");
  const sentinel = path.join(storage, "ancestor-sentinel.txt");
  writeSkill(source, "safe-skill");
  fs.mkdirSync(subjectsRoot, { recursive: true });
  fs.writeFileSync(sentinel, "must survive\n", "utf8");

  assert.throws(
    () => importLocalSkill(source, { subjectId: "..", subjectsRoot }),
    /subject id|dot segment|unsafe/i
  );
  assert.equal(fs.readFileSync(sentinel, "utf8"), "must survive\n");
});

test("loaded subject manifests cannot redirect trusted subject or scan paths", () => {
  const root = tempRoot("barena-subject-manifest-paths-");
  const source = path.join(root, "source");
  const subjectsRoot = path.join(root, "subjects");
  const outside = path.join(root, "outside");
  writeSkill(source, "safe-skill");
  fs.mkdirSync(outside, { recursive: true });
  const manifest = importLocalSkill(source, { subjectId: "safe-skill", subjectsRoot });
  const manifestPath = path.join(manifest.paths.subject_root, "subject-manifest.json");

  writeJson(manifestPath, {
    ...manifest,
    paths: {
      ...manifest.paths,
      subject_root: outside,
      scan_report: path.join(outside, "scan-report.json"),
    },
  });

  assert.throws(
    () => loadSubjectManifest("safe-skill", subjectsRoot),
    /manifest path|subject root|scan report|outside/i
  );
});

test("local Skill import rejects every symlink before creating retained metadata", () => {
  const root = tempRoot("barena-import-symlink-");
  const source = path.join(root, "source");
  const subjectsRoot = path.join(root, "subjects");
  const outside = path.join(root, "outside.txt");
  writeSkill(source, "linked-skill");
  fs.writeFileSync(outside, "outside\n", "utf8");
  fs.symlinkSync(outside, path.join(source, "linked.txt"));

  assert.throws(
    () => importLocalSkill(source, { subjectId: "linked-skill", subjectsRoot }),
    /symlink/i
  );
  assert.equal(fs.existsSync(path.join(subjectsRoot, "linked-skill")), false);
});

test("a missing static-scan root blocks instead of producing an empty pass", () => {
  const root = tempRoot("barena-missing-scan-root-");
  const report = scanSubjectDirectory("missing-subject", path.join(root, "missing"));

  assert.equal(report.decision, "blocked");
  assert.equal(report.findings.some((finding) => finding.rule_id === "scan-root-missing"), true);
});

test("static admission scans bytes staged under runs and subjects directories", () => {
  const root = tempRoot("barena-static-byte-alignment-");
  const source = path.join(root, "source");
  fs.mkdirSync(path.join(source, "runs"), { recursive: true });
  fs.mkdirSync(path.join(source, "subjects"), { recursive: true });
  fs.writeFileSync(path.join(source, "SKILL.md"), "---\nname: aligned-skill\n---\nsafe\n", "utf8");
  fs.writeFileSync(path.join(source, "runs", "unsafe.txt"), "BARENA_UNSAFE\n", "utf8");
  fs.writeFileSync(path.join(source, "subjects", "also-scanned.txt"), "safe\n", "utf8");

  const prepared = prepareStaticAdmission({
    evaluation_root: path.join(root, "evaluation"),
    subjects: [{
      relation: "candidate",
      subject_kind: "skill",
      subject_id: "aligned-skill",
      source_path: source,
      fingerprint: hashDirectory(source),
    }],
  });

  assert.equal(prepared.report.decision, "rejected");
  assert.equal(prepared.report.subjects[0].scan.scanned_files.includes("runs/unsafe.txt"), true);
  assert.equal(prepared.report.subjects[0].scan.scanned_files.includes("subjects/also-scanned.txt"), true);
});

test("immutable admission snapshots preserve executable permission and remove writes", () => {
  const root = tempRoot("barena-static-executable-");
  const source = path.join(root, "source");
  writeSkill(source, "executable-skill");
  const executable = path.join(source, "run.sh");
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(executable, 0o755);

  const prepared = prepareStaticAdmission({
    evaluation_root: path.join(root, "evaluation"),
    subjects: [{
      relation: "candidate",
      subject_kind: "skill",
      subject_id: "executable-skill",
      source_path: source,
      fingerprint: hashDirectory(source),
    }],
  });
  const snapshotExecutable = path.join(prepared.subjects[0].snapshot_path, "run.sh");
  const mode = fs.statSync(snapshotExecutable).mode & 0o777;

  assert.equal(mode & 0o111, 0o111);
  assert.equal(mode & 0o222, 0);
});

test("directory fingerprints frame paths, entry types, and content lengths unambiguously", () => {
  const root = tempRoot("barena-framed-fingerprint-");
  const left = path.join(root, "left");
  const right = path.join(root, "right");
  const empty = path.join(root, "empty");
  const withDirectory = path.join(root, "with-directory");
  fs.mkdirSync(left);
  fs.mkdirSync(right);
  fs.mkdirSync(empty);
  fs.mkdirSync(path.join(withDirectory, "empty-dir"), { recursive: true });
  fs.writeFileSync(path.join(left, "a"), "bc", "utf8");
  fs.writeFileSync(path.join(right, "ab"), "c", "utf8");

  assert.notEqual(hashDirectory(left), hashDirectory(right));
  assert.notEqual(hashDirectory(empty), hashDirectory(withDirectory));
});

test("case IDs reject dot segments before they can select parent run directories", async (t) => {
  const root = tempRoot("barena-case-dot-segment-");
  const agentCase = path.join(root, "agent-case.json");
  const nativeCase = path.join(root, "native-case.json");
  writeJson(agentCase, {
    schema: "barena.agent_e2e_case.v1",
    case_id: ".",
    target: { adapter: "openclaw", agent: "main" },
    task: { prompt: "safe" },
    assertions: { artifacts: [] },
    isolation: { level: "policy_only", network: "disabled", writable_roots: ["workspace"] },
  });
  writeJson(nativeCase, {
    schema: "barena.xiaoba_native_case.v1",
    case_id: "..",
    purpose: "safety",
    task: { prompt: "safe" },
    assertions: { artifacts: [] },
  });

  await t.test("Agent E2E", () => {
    assert.throws(() => loadAgentE2ECase(agentCase), /case_id.*dot|case_id.*unsafe|case_id.*segment/i);
  });
  await t.test("XiaoBa native", () => {
    assert.throws(() => loadXiaoBaNativeCase(nativeCase), /case_id.*dot|case_id.*unsafe|case_id.*segment/i);
  });
});

function writeSkill(root: string, name: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "SKILL.md"), `---\nname: ${name}\n---\nsafe\n`, "utf8");
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function tempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
