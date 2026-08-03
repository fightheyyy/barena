import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createRunPackageV1,
  EngineEventWriter,
  EngineProtocolError,
  parseEngineRequestV1,
  parseRunPackageV1,
  verifyRunPackageV1,
  writeRunPackageV1,
} from "../src/engine-protocol";
import { readJson, readNdjson } from "../src/utils/fs";

test("Engine request v1 binds a Server-assigned run identity and absolute runs root", () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "barena-engine-request-"));
  try {
    const request = parseEngineRequestV1({
      schema: "barena.engine_request.v1",
      request_id: "request-001",
      run_id: "explore-platform-001",
      operation: "explore",
      runs_root: runsRoot,
      input: { scenario: { schema: "barena.explore_scenario.v1" } },
      runtime: { adapter: "xiaobaos" },
    });
    assert.equal(request.run_id, "explore-platform-001");
    assert.equal(request.runs_root, path.resolve(runsRoot));

    assert.throws(
      () =>
        parseEngineRequestV1({
          ...request,
          run_id: "../escape",
        }),
      EngineProtocolError
    );
    assert.throws(
      () =>
        parseEngineRequestV1({
          ...request,
          runs_root: "runs",
        }),
      /runs_root must be an absolute path/
    );
  } finally {
    fs.rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("Engine event writer durably appends before delivery and resumes monotonic sequence", async () => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "barena-engine-events-"));
  try {
    const delivered: number[] = [];
    const writer = new EngineEventWriter({
      run_root: runRoot,
      run_id: "run-001",
      operation: "replay",
      now: () => new Date("2026-07-30T10:00:00.000Z"),
      emit: (_line, event) => {
        const persisted = readNdjson<{ sequence: number }>(
          path.join(runRoot, "events.ndjson")
        );
        assert.equal(persisted.at(-1)?.sequence, event.sequence);
        delivered.push(event.sequence);
      },
    });
    const first = await writer.write({
      kind: "progress",
      phase: "probe",
      actor: "engine",
      payload: { status: "started" },
    });
    const second = await writer.write({
      kind: "progress",
      phase: "attempt",
      actor: "target",
      attempt_id: "attempt-001",
      payload: { status: "completed" },
    });
    assert.deepEqual(delivered, [1, 2]);
    assert.equal(first.event_id, "run-001.1");
    assert.equal(second.sequence, 2);

    const resumed = new EngineEventWriter({
      run_root: runRoot,
      run_id: "run-001",
      operation: "replay",
    });
    assert.equal(
      (
        await resumed.write({
          kind: "terminal",
          phase: "complete",
          actor: "engine",
          payload: { status: "complete" },
        })
      ).sequence,
      3
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("Run package v1 exposes only normalized, hash-verified, non-symlink files", () => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "barena-run-package-"));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "barena-run-outside-"));
  try {
    fs.mkdirSync(path.join(runRoot, "reports"), { recursive: true });
    fs.writeFileSync(
      path.join(runRoot, "reports", "report.json"),
      '{"decision":"cleared"}\n',
      "utf8"
    );
    fs.writeFileSync(
      path.join(runRoot, "events.ndjson"),
      '{"sequence":1}\n',
      "utf8"
    );
    const manifest = createRunPackageV1({
      run_root: runRoot,
      run_id: "run-package-001",
      status: "complete",
      result_ref: "reports/report.json",
      files: [
        {
          ref: "reports/report.json",
          kind: "result",
          media_type: "application/json",
        },
        {
          ref: "events.ndjson",
          kind: "events",
          media_type: "application/x-ndjson",
        },
      ],
    });
    const manifestRef = writeRunPackageV1(runRoot, manifest);
    assert.deepEqual(
      verifyRunPackageV1(runRoot, readJson(manifestRef)),
      parseRunPackageV1(manifest)
    );

    fs.appendFileSync(path.join(runRoot, "reports", "report.json"), "tampered");
    assert.throws(
      () => verifyRunPackageV1(runRoot, manifest),
      /hash mismatch|size mismatch/
    );

    fs.writeFileSync(path.join(outsideRoot, "secret.txt"), "secret", "utf8");
    fs.symlinkSync(
      path.join(outsideRoot, "secret.txt"),
      path.join(runRoot, "secret-link")
    );
    assert.throws(
      () =>
        createRunPackageV1({
          run_root: runRoot,
          run_id: "run-package-002",
          status: "complete",
          result_ref: "secret-link",
          files: [
            {
              ref: "secret-link",
              kind: "evidence",
              media_type: "text/plain",
            },
          ],
        }),
      /may not contain symlinks/
    );
    assert.throws(
      () =>
        parseRunPackageV1({
          ...manifest,
          result_ref: "../outside.json",
        }),
      /run-relative POSIX path/
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});
