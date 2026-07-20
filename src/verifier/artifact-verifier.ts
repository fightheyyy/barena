import fs from "node:fs";
import type { ArtifactAssertionResult } from "../e2e/types";

export type JsonScalar = string | number | boolean | null;

export type StructuredJsonCheck =
  | { kind: "type"; pointer: string; expected: "object" | "array" | "string" | "number" | "boolean" | "null" }
  | { kind: "required_keys"; pointer: string; keys: string[] }
  | { kind: "array_min_items"; pointer: string; min_items: number }
  | { kind: "array_contains"; pointer: string; subset: Record<string, JsonScalar> }
  | {
      kind: "directed_graph";
      nodes_pointer: string;
      edges_pointer: string;
      node_id_key: string;
      edge_from_key: string;
      edge_to_key: string;
      start_id: string;
      allowed_external_targets?: string[];
      require_all_nodes_reachable?: boolean;
    };

export interface StructuredArtifactAssertion {
  path: string;
  exists?: boolean;
  contains?: string;
  json_checks?: StructuredJsonCheck[];
}

export function verifyArtifactContent(
  assertion: StructuredArtifactAssertion,
  artifactPath: string,
  relativePath: string
): ArtifactAssertionResult {
  const expected = assertion.exists ?? true;
  const exists = fs.existsSync(artifactPath) && fs.statSync(artifactPath).isFile();
  if (exists !== expected) {
    return {
      path: relativePath,
      status: "fail",
      detail: expected ? "Expected artifact does not exist." : "Artifact exists but was expected to be absent.",
    };
  }
  if (!exists) return { path: relativePath, status: "pass", detail: "Artifact absence matched the assertion." };

  const content = fs.readFileSync(artifactPath, "utf8");
  if (assertion.contains !== undefined && !content.includes(assertion.contains)) {
    return { path: relativePath, status: "fail", detail: "Artifact does not contain the expected text." };
  }

  if (assertion.json_checks?.length) {
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch (error) {
      return {
        path: relativePath,
        status: "fail",
        detail: `Artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    for (const check of assertion.json_checks) {
      const failure = evaluateJsonCheck(value, check);
      if (failure) return { path: relativePath, status: "fail", detail: failure };
    }
  }

  const checks = Number(assertion.contains !== undefined) + (assertion.json_checks?.length ?? 0);
  return {
    path: relativePath,
    status: "pass",
    detail: checks > 0 ? `Artifact passed ${checks} content check${checks === 1 ? "" : "s"}.` : "Artifact existence matched the assertion.",
  };
}

export function validateStructuredJsonCheck(check: StructuredJsonCheck, label: string): void {
  if (!check || typeof check !== "object") throw new Error(`${label} must be an object`);
  if (check.kind === "type") {
    validatePointer(check.pointer, label);
    if (!["object", "array", "string", "number", "boolean", "null"].includes(check.expected)) throw new Error(`${label}.expected is invalid`);
    return;
  }
  if (check.kind === "required_keys") {
    validatePointer(check.pointer, label);
    if (!Array.isArray(check.keys) || check.keys.length === 0 || check.keys.some((key) => !safeFieldName(key))) {
      throw new Error(`${label}.keys must contain non-empty field names`);
    }
    if (new Set(check.keys).size !== check.keys.length) throw new Error(`${label}.keys must be unique`);
    return;
  }
  if (check.kind === "array_min_items") {
    validatePointer(check.pointer, label);
    if (!Number.isInteger(check.min_items) || check.min_items < 1) throw new Error(`${label}.min_items must be positive`);
    return;
  }
  if (check.kind === "array_contains") {
    validatePointer(check.pointer, label);
    if (!isRecord(check.subset) || Object.keys(check.subset).length === 0) throw new Error(`${label}.subset must be non-empty`);
    for (const [key, value] of Object.entries(check.subset)) {
      if (!safeFieldName(key) || !isJsonScalar(value)) throw new Error(`${label}.subset must contain scalar fields`);
    }
    return;
  }
  if (check.kind === "directed_graph") {
    validatePointer(check.nodes_pointer, `${label}.nodes_pointer`);
    validatePointer(check.edges_pointer, `${label}.edges_pointer`);
    for (const [key, value] of Object.entries({
      node_id_key: check.node_id_key,
      edge_from_key: check.edge_from_key,
      edge_to_key: check.edge_to_key,
      start_id: check.start_id,
    })) {
      if (!safeFieldName(value)) throw new Error(`${label}.${key} must be non-empty`);
    }
    if (check.allowed_external_targets !== undefined) {
      if (!Array.isArray(check.allowed_external_targets) || check.allowed_external_targets.some((value) => !safeFieldName(value))) {
        throw new Error(`${label}.allowed_external_targets must contain non-empty strings`);
      }
      if (new Set(check.allowed_external_targets).size !== check.allowed_external_targets.length) {
        throw new Error(`${label}.allowed_external_targets must be unique`);
      }
    }
    return;
  }
  throw new Error(`${label}.kind is unsupported`);
}

function evaluateJsonCheck(root: unknown, check: StructuredJsonCheck): string | null {
  if (check.kind === "type") {
    const value = resolvePointer(root, check.pointer);
    const observed = jsonType(value);
    return observed === check.expected ? null : `JSON pointer ${displayPointer(check.pointer)} had type ${observed}, expected ${check.expected}.`;
  }
  if (check.kind === "required_keys") {
    const value = resolvePointer(root, check.pointer);
    if (!isRecord(value)) return `JSON pointer ${displayPointer(check.pointer)} is not an object.`;
    const missing = check.keys.filter((key) => !(key in value));
    return missing.length ? `JSON pointer ${displayPointer(check.pointer)} is missing keys: ${missing.join(", ")}.` : null;
  }
  if (check.kind === "array_min_items") {
    const value = resolvePointer(root, check.pointer);
    if (!Array.isArray(value)) return `JSON pointer ${displayPointer(check.pointer)} is not an array.`;
    return value.length >= check.min_items ? null : `JSON pointer ${displayPointer(check.pointer)} had ${value.length} items, expected at least ${check.min_items}.`;
  }
  if (check.kind === "array_contains") {
    const value = resolvePointer(root, check.pointer);
    if (!Array.isArray(value)) return `JSON pointer ${displayPointer(check.pointer)} is not an array.`;
    return value.some((item) => isRecord(item) && objectContains(item, check.subset))
      ? null
      : `JSON pointer ${displayPointer(check.pointer)} did not contain the required object subset.`;
  }
  return verifyDirectedGraph(root, check);
}

function verifyDirectedGraph(root: unknown, check: Extract<StructuredJsonCheck, { kind: "directed_graph" }>): string | null {
  const nodes = resolvePointer(root, check.nodes_pointer);
  const edges = resolvePointer(root, check.edges_pointer);
  if (!Array.isArray(nodes)) return `JSON pointer ${displayPointer(check.nodes_pointer)} is not an array.`;
  if (!Array.isArray(edges)) return `JSON pointer ${displayPointer(check.edges_pointer)} is not an array.`;

  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (!isRecord(node) || typeof node[check.node_id_key] !== "string" || !String(node[check.node_id_key]).trim()) {
      return `Graph node is missing string field ${check.node_id_key}.`;
    }
    const nodeId = String(node[check.node_id_key]);
    if (nodeIds.has(nodeId)) return `Graph contains duplicate node ID ${nodeId}.`;
    nodeIds.add(nodeId);
  }
  if (!nodeIds.has(check.start_id)) return `Graph start node ${check.start_id} is missing.`;

  const allowedExternal = new Set(check.allowed_external_targets ?? []);
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!isRecord(edge) || typeof edge[check.edge_from_key] !== "string" || typeof edge[check.edge_to_key] !== "string") {
      return `Graph edge is missing string fields ${check.edge_from_key}/${check.edge_to_key}.`;
    }
    const from = String(edge[check.edge_from_key]);
    const to = String(edge[check.edge_to_key]);
    if (!nodeIds.has(from)) return `Graph edge source ${from} is not a declared node.`;
    if (!nodeIds.has(to) && !allowedExternal.has(to)) return `Graph edge target ${to} is neither a node nor an allowed terminal.`;
    const targets = adjacency.get(from) ?? [];
    targets.push(to);
    adjacency.set(from, targets);
  }

  if (check.require_all_nodes_reachable ?? true) {
    const reached = new Set<string>();
    const queue = [check.start_id];
    while (queue.length) {
      const current = queue.shift()!;
      if (reached.has(current)) continue;
      reached.add(current);
      for (const target of adjacency.get(current) ?? []) {
        if (nodeIds.has(target) && !reached.has(target)) queue.push(target);
      }
    }
    const unreachable = [...nodeIds].filter((nodeId) => !reached.has(nodeId));
    if (unreachable.length) return `Graph contains unreachable nodes: ${unreachable.slice(0, 5).join(", ")}.`;
  }
  return null;
}

function resolvePointer(root: unknown, pointer: string): unknown {
  validatePointer(pointer, "JSON pointer");
  if (pointer === "") return root;
  let value = root;
  for (const encoded of pointer.slice(1).split("/")) {
    const segment = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return undefined;
      value = value[Number(segment)];
    } else if (isRecord(value)) {
      value = value[segment];
    } else {
      return undefined;
    }
  }
  return value;
}

function validatePointer(pointer: string, label: string): void {
  if (typeof pointer !== "string" || (pointer !== "" && !pointer.startsWith("/"))) {
    throw new Error(`${label} must be an RFC 6901 JSON pointer`);
  }
  if (/(^|[^~])~($|[^01])/.test(pointer)) throw new Error(`${label} contains an invalid JSON pointer escape`);
}

function displayPointer(pointer: string): string {
  return pointer || "<root>";
}

function jsonType(value: unknown): "object" | "array" | "string" | "number" | "boolean" | "null" | "undefined" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "undefined") return "undefined";
  return "undefined";
}

function objectContains(value: Record<string, unknown>, subset: Record<string, JsonScalar>): boolean {
  return Object.entries(subset).every(([key, expected]) => Object.is(value[key], expected));
}

function safeFieldName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isJsonScalar(value: unknown): value is JsonScalar {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
