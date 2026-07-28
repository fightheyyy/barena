import fs from "node:fs";
import path from "node:path";
import { readJson } from "../utils/fs";
import type { ExploreScenarioV1 } from "./types";

export function loadExploreScenario(filePath: string): ExploreScenarioV1 {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`Explore Scenario file does not exist: ${absolute}`);
  }
  return validateExploreScenario(readJson<unknown>(absolute));
}

export function createAdHocExploreScenario(input: {
  role: string;
  task: string;
  scenario_id?: string;
  model?: string;
  skill?: string;
  env_allowlist?: string[];
  max_turns?: number;
  timeout_ms?: number;
}): ExploreScenarioV1 {
  const role = input.role.trim();
  const scenarioId =
    input.scenario_id?.trim() ||
    `explore-${role.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")}`;
  return validateExploreScenario({
    schema: "barena.explore_scenario.v1",
    scenario_id: scenarioId,
    target: {
      runtime: "xiaobaos",
      role,
      ...(input.model && { model: input.model }),
      ...(input.skill && { skill: input.skill }),
      env_allowlist: input.env_allowlist ?? [],
    },
    objective: input.task,
    success_criteria: [],
    max_turns: input.max_turns ?? 4,
    timeout_ms: input.timeout_ms ?? 180_000,
    isolation: {
      level: "policy_only",
      network: "allowlisted",
      writable_roots: ["workspace"],
    },
  });
}

export function validateExploreScenario(value: unknown): ExploreScenarioV1 {
  const root = record(value, "Explore Scenario");
  if (root.schema !== "barena.explore_scenario.v1") {
    throw new Error("Explore Scenario schema must be barena.explore_scenario.v1");
  }
  const scenarioId = safeId(root.scenario_id, "scenario_id");
  const target = record(root.target, "target");
  if (target.runtime !== "xiaobaos") {
    throw new Error("Explore v1 currently supports target.runtime=xiaobaos");
  }
  const role = safeId(target.role, "target.role");
  const objective = nonEmptyString(root.objective, "objective", 24_000);
  const maxTurns = integer(root.max_turns, "max_turns", 1, 12);
  const timeoutMs = integer(root.timeout_ms, "timeout_ms", 1_000, 900_000);
  const isolation = record(root.isolation, "isolation");
  if (
    isolation.level !== "policy_only" ||
    isolation.network !== "disabled" &&
      isolation.network !== "allowlisted" &&
      isolation.network !== "unrestricted"
  ) {
    throw new Error("Explore isolation must declare level=policy_only and a valid network policy");
  }
  const writableRoots = stringArray(isolation.writable_roots, "isolation.writable_roots");
  if (writableRoots.length !== 1 || writableRoots[0] !== "workspace") {
    throw new Error("Explore writable_roots must be exactly [\"workspace\"]");
  }
  const envAllowlist = stringArray(target.env_allowlist ?? [], "target.env_allowlist");
  if (envAllowlist.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new Error("target.env_allowlist contains an invalid environment variable name");
  }
  const user = root.user === undefined ? undefined : record(root.user, "user");
  const evaluator =
    root.evaluator === undefined ? undefined : record(root.evaluator, "evaluator");
  return {
    schema: "barena.explore_scenario.v1",
    scenario_id: scenarioId,
    target: {
      runtime: "xiaobaos",
      role,
      ...(optionalString(target.model, "target.model") && {
        model: optionalString(target.model, "target.model"),
      }),
      ...(optionalString(target.skill, "target.skill") && {
        skill: safeId(target.skill, "target.skill"),
      }),
      env_allowlist: envAllowlist,
    },
    objective,
    ...(user && {
      user: {
        ...(optionalString(user.persona, "user.persona", 4_000) && {
          persona: optionalString(user.persona, "user.persona", 4_000),
        }),
        constraints: stringArray(user.constraints ?? [], "user.constraints", 100, 4_000),
      },
    }),
    success_criteria: stringArray(
      root.success_criteria ?? [],
      "success_criteria",
      100,
      4_000
    ),
    max_turns: maxTurns,
    timeout_ms: timeoutMs,
    isolation: {
      level: "policy_only",
      network: isolation.network as ExploreScenarioV1["isolation"]["network"],
      writable_roots: ["workspace"],
    },
    ...(evaluator && {
      evaluator: {
        ...(evaluator.user_role !== undefined && {
          user_role: safeId(evaluator.user_role, "evaluator.user_role"),
        }),
        ...(evaluator.inspector_role !== undefined && {
          inspector_role: safeId(evaluator.inspector_role, "evaluator.inspector_role"),
        }),
        ...(evaluator.reviewer_role !== undefined && {
          reviewer_role: safeId(evaluator.reviewer_role, "evaluator.reviewer_role"),
        }),
      },
    }),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function safeId(value: unknown, label: string): string {
  const text = nonEmptyString(value, label, 120);
  if (!/^[A-Za-z0-9._-]+$/.test(text) || text === "." || text === "..") {
    throw new Error(`${label} must be a safe identifier`);
  }
  return text;
}

function nonEmptyString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${label} must be a non-empty string up to ${max} characters`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string, max = 1_000): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return nonEmptyString(value, label, max);
}

function integer(
  value: unknown,
  label: string,
  min: number,
  max: number
): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return Number(value);
}

function stringArray(
  value: unknown,
  label: string,
  maxItems = 100,
  maxLength = 1_000
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${label} must be an array with at most ${maxItems} items`);
  }
  return value.map((item, index) => nonEmptyString(item, `${label}[${index}]`, maxLength));
}
