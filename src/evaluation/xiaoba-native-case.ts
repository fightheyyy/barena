import fs from "node:fs";
import path from "node:path";
import { validateStructuredJsonCheck } from "../verifier/artifact-verifier";
import type { XiaoBaNativeCaseV1 } from "./xiaoba-native-types";

export function loadXiaoBaNativeCase(casePath: string): XiaoBaNativeCaseV1 {
  const absolutePath = path.resolve(casePath);
  const value = JSON.parse(fs.readFileSync(absolutePath, "utf8")) as XiaoBaNativeCaseV1;
  if (value?.schema !== "barena.xiaoba_native_case.v1") {
    throw new Error("XiaobaOS native case schema must be barena.xiaoba_native_case.v1");
  }
  if (!value.case_id || value.case_id === "." || value.case_id === ".." || !/^[A-Za-z0-9._-]+$/.test(value.case_id)) {
    throw new Error("XiaobaOS native case_id must be a safe path segment and may not be . or ..");
  }
  if (!["effectiveness", "regression", "safety"].includes(value.purpose)) {
    throw new Error("XiaobaOS native case purpose must be effectiveness, regression, or safety");
  }
  if (!value.task?.prompt?.trim()) throw new Error("XiaobaOS native case task.prompt must be non-empty");
  if (!Array.isArray(value.assertions?.artifacts) || value.assertions.artifacts.length === 0) {
    throw new Error("XiaobaOS native case assertions.artifacts must be a non-empty array");
  }
  const assertionPaths = new Set<string>();
  for (const assertion of value.assertions.artifacts) {
    if (!assertion || typeof assertion.path !== "string" || !assertion.path.trim()) {
      throw new Error("XiaobaOS native artifact assertion path must be non-empty");
    }
    const normalized = path.normalize(assertion.path);
    if (path.isAbsolute(assertion.path) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
      throw new Error("XiaobaOS native artifact assertion path must stay inside the workspace");
    }
    if (assertionPaths.has(normalized)) throw new Error(`Duplicate XiaobaOS native artifact assertion path: ${normalized}`);
    assertionPaths.add(normalized);
    if (assertion.contains !== undefined && (typeof assertion.contains !== "string" || !assertion.contains.trim())) {
      throw new Error(`XiaobaOS native artifact assertion contains must be non-empty: ${normalized}`);
    }
    if (assertion.exists === false && assertion.contains !== undefined) {
      throw new Error(`XiaobaOS native artifact assertion cannot combine exists=false with contains: ${normalized}`);
    }
    if (assertion.exists === false && assertion.json_checks !== undefined) {
      throw new Error(`XiaobaOS native artifact assertion cannot combine exists=false with json_checks: ${normalized}`);
    }
    if (assertion.json_checks !== undefined) {
      if (!Array.isArray(assertion.json_checks) || assertion.json_checks.length === 0) {
        throw new Error(`XiaobaOS native artifact assertion json_checks must be non-empty: ${normalized}`);
      }
      assertion.json_checks.forEach((check, index) => {
        validateStructuredJsonCheck(check, `${normalized}.json_checks[${index}]`);
      });
    }
  }
  for (const [name, number] of [
    ["max_turns", value.max_turns],
    ["replay_attempts", value.replay_attempts],
    ["max_replay_cases", value.max_replay_cases],
  ] as const) {
    if (number !== undefined && (!Number.isInteger(number) || number < 1)) {
      throw new Error(`XiaobaOS native case ${name} must be a positive integer`);
    }
  }
  if (value.timeout_ms !== undefined && (!Number.isInteger(value.timeout_ms) || value.timeout_ms < 1000)) {
    throw new Error("XiaobaOS native case timeout_ms must be an integer of at least 1000");
  }
  const caseDir = path.dirname(absolutePath);
  const fixtureDestinations = new Set<string>();
  const fixtures = value.fixtures?.map((fixture) => {
    if (!fixture || typeof fixture.source_path !== "string" || !fixture.source_path.trim()) {
      throw new Error("XiaobaOS native fixture source_path must be non-empty");
    }
    if (typeof fixture.destination !== "string" || !fixture.destination.trim()) {
      throw new Error("XiaobaOS native fixture destination must be non-empty");
    }
    const destination = path.normalize(fixture.destination);
    if (path.isAbsolute(fixture.destination) || destination === ".." || destination.startsWith(`..${path.sep}`)) {
      throw new Error("XiaobaOS native fixture destination must stay inside the workspace");
    }
    if (fixtureDestinations.has(destination)) throw new Error(`Duplicate XiaobaOS native fixture destination: ${destination}`);
    fixtureDestinations.add(destination);
    const sourcePath = path.isAbsolute(fixture.source_path)
      ? path.resolve(fixture.source_path)
      : path.resolve(caseDir, fixture.source_path);
    if (!fs.existsSync(sourcePath)) throw new Error(`XiaobaOS native fixture source does not exist: ${sourcePath}`);
    if (fs.lstatSync(sourcePath).isSymbolicLink()) throw new Error(`XiaobaOS native fixture source may not be a symlink: ${sourcePath}`);
    return { ...fixture, source_path: sourcePath, destination };
  });
  return { ...value, ...(fixtures && { fixtures }) };
}
