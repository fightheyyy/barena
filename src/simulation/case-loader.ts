import path from "node:path";
import { readJson } from "../utils/fs";
import type { AgentSimulationCaseV1 } from "./types";

export function loadAgentSimulationCase(casePath: string): AgentSimulationCaseV1 {
  const value = readJson<AgentSimulationCaseV1>(path.resolve(casePath));
  validateAgentSimulationCase(value);
  return value;
}

export function validateAgentSimulationCase(value: AgentSimulationCaseV1): void {
  if (!value || value.schema !== "barena.agent_simulation_case.v1") {
    throw new Error("Simulation case schema must be barena.agent_simulation_case.v1");
  }
  if (!value.case_id?.trim() || !/^[a-zA-Z0-9._-]+$/.test(value.case_id)) {
    throw new Error("Simulation case_id must contain only letters, numbers, dot, underscore, or dash");
  }
  if (!value.source?.project?.trim() || !value.source.url?.trim() || !value.source.commit?.trim() || !value.source.license?.trim()) {
    throw new Error("Simulation source must include project, url, commit, and license");
  }
  if (!["xiaobaos", "claude-code", "codex", "openclaw"].includes(value.target?.adapter)) {
    throw new Error("Simulation target.adapter must be xiaobaos, claude-code, codex, or openclaw");
  }
  if (!Array.isArray(value.turns) || value.turns.length === 0 || value.turns.length > 20) {
    throw new Error("Simulation turns must contain between 1 and 20 scripted user turns");
  }
  if (value.turns.some((turn) => !turn?.user?.trim())) {
    throw new Error("Every simulation turn must contain a non-empty user message");
  }
  const assertion = value.assertions?.final_response;
  if (!assertion) throw new Error("Simulation assertions.final_response is required");
  if (![assertion.contains_all, assertion.contains_any, assertion.excludes].some((items) => items?.length)) {
    throw new Error("Simulation final_response must define at least one assertion");
  }
  for (const items of [assertion.contains_all, assertion.contains_any, assertion.excludes]) {
    if (items?.some((item) => !item.trim())) {
      throw new Error("Simulation assertion values must be non-empty strings");
    }
  }
  if (!Number.isInteger(value.timeout_ms) || value.timeout_ms < 1_000) {
    throw new Error("Simulation timeout_ms must be an integer of at least 1000");
  }
  if (
    value.isolation?.level !== "policy_only" ||
    value.isolation.writable_roots?.length !== 1 ||
    value.isolation.writable_roots[0] !== "workspace"
  ) {
    throw new Error("Simulation requires isolation.level=policy_only and writable_roots=[workspace]");
  }
}
