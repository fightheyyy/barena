import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { redactSecretsInDirectory } from "../src/explore/secret-redaction";

test("secret redaction skips only DSH-owned dependencies while scanning its sessions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-dsh-redaction-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dshRoot = path.join(
    root,
    "workspaces",
    "target",
    ".barena-dsh",
    "run-1"
  );
  const dependencies = path.join(dshRoot, "profiles", "node_modules");
  const sessions = path.join(dshRoot, "sessions");
  fs.mkdirSync(dependencies, { recursive: true });
  fs.mkdirSync(sessions, { recursive: true });
  fs.symlinkSync(path.join(root, "missing-package"), path.join(dependencies, "package"));
  fs.writeFileSync(path.join(sessions, "session.jsonl"), "token=real-secret\n", "utf8");

  const result = redactSecretsInDirectory(root, ["real-secret"]);

  assert.equal(result.occurrences, 1);
  assert.deepEqual(result.unscanned_files, []);
  assert.equal(
    fs.readFileSync(path.join(sessions, "session.jsonl"), "utf8"),
    "token=***********\n"
  );
});

test("secret redaction still reports unrelated symlinks as unscanned evidence", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "barena-redaction-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.symlinkSync(path.join(root, "missing"), path.join(root, "unsafe-link"));

  const result = redactSecretsInDirectory(root, ["real-secret"]);

  assert.deepEqual(result.unscanned_files, ["unsafe-link"]);
});
