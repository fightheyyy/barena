import crypto from "node:crypto";
import path from "node:path";
import {
  RuntimeAdapterError,
  XiaobaOSRuntimeAdapter,
  type AgentRuntimeAdapter,
  type RuntimeProbeResult,
} from "../runtime-adapters";
import {
  XIAOBA_EVOLUTION_ROLES,
  type XiaobaEvolutionRoleDescriptor,
  type XiaobaEvolutionRoleId,
  type XiaobaEvolutionRoleTurnRequest,
  type XiaobaEvolutionRuntimeConfigV1,
  type XiaobaEvolutionRuntimeManifestV1,
} from "./types";

export const XIAOBA_EVOLUTION_ROLE_DESCRIPTORS: XiaobaEvolutionRoleDescriptor[] = [
  {
    id: "user-cat",
    display_name: "UserCat",
    responsibility: "Simulate one natural, incomplete user turn without judging the Agent.",
    output: "user turn",
  },
  {
    id: "inspector-cat",
    display_name: "InspectorCat",
    responsibility: "Locate a failure mode in retained evidence and pair it with a replayable Case.",
    output: "finding + case",
  },
  {
    id: "reviewer-cat",
    display_name: "ReviewerCat",
    responsibility: "Review verifier-backed evidence and emit a semantic pass, fail, or blocked verdict.",
    output: "semantic review",
  },
  {
    id: "evolution-cat",
    display_name: "EvolutionCat",
    responsibility: "Create a minimal Role, Skill, or Memory candidate from an accepted finding.",
    output: "role / skill / memory candidate",
  },
];

const ROLE_IDS = new Set<string>(XIAOBA_EVOLUTION_ROLES);

export interface XiaobaEvolutionRuntimeOptions {
  adapter?: AgentRuntimeAdapter;
  runtime?: XiaobaEvolutionRuntimeConfigV1;
}

export class XiaobaEvolutionRuntime {
  private readonly adapter: AgentRuntimeAdapter;

  constructor(options: XiaobaEvolutionRuntimeOptions = {}) {
    this.adapter = options.adapter ?? new XiaobaOSRuntimeAdapter(options.runtime);
  }

  async probe(): Promise<XiaobaEvolutionRuntimeManifestV1> {
    try {
      const result = await this.adapter.probe({
        required_targets: [...XIAOBA_EVOLUTION_ROLES],
      });
      return manifestFromProbe(result);
    } catch {
      return baseManifest({
        status: "blocked",
        reason_code: "runtime_error",
        detail: "XiaoBaOS could not be probed by the embedded evolution worker.",
      });
    }
  }

  async runRoleTurn(
    request: XiaobaEvolutionRoleTurnRequest,
    signal?: AbortSignal
  ): Promise<Awaited<ReturnType<AgentRuntimeAdapter["sendTurn"]>>> {
    assertEvolutionRole(request.role);
    if (!isSafeIdentifier(request.request_id) || !isSafeIdentifier(request.run_id)) {
      throw new RuntimeAdapterError(
        "config_invalid",
        "Evolution Runtime request_id and run_id must be safe identifiers."
      );
    }
    if (!request.prompt.trim()) {
      throw new RuntimeAdapterError("protocol_error", "Evolution Runtime prompt is empty.");
    }
    if (!path.isAbsolute(request.workspace)) {
      throw new RuntimeAdapterError(
        "config_invalid",
        "Evolution Runtime workspace must be an absolute path."
      );
    }
    if (!Number.isInteger(request.timeout_ms) || request.timeout_ms < 1) {
      throw new RuntimeAdapterError(
        "config_invalid",
        "Evolution Runtime timeout_ms must be a positive integer."
      );
    }
    if (signal?.aborted) throw abortError();

    const identity = crypto
      .createHash("sha256")
      .update(`${request.run_id}:${request.request_id}:${request.role}`)
      .digest("hex")
      .slice(0, 24);
    const session = await this.adapter.openSession({
      run_id: request.run_id,
      scenario_id: "cloud-evolution",
      attempt_id: request.role,
      session_id: `evo-${identity}`,
      thread_id: `evo-thread-${identity}`,
      workspace: path.resolve(request.workspace),
      target: { role: request.role },
    });
    let abortRequested = false;
    const cancel = () => {
      abortRequested = true;
      void this.adapter.cancel(session, "Evolution Runtime request cancelled");
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (signal?.aborted || abortRequested) throw abortError();
      return await this.adapter.sendTurn(session, {
        message: request.prompt,
        timeout_ms: request.timeout_ms,
        ...(request.telemetry && { telemetry: request.telemetry }),
      });
    } finally {
      signal?.removeEventListener("abort", cancel);
      await this.adapter.close(session);
    }
  }
}

export function isXiaobaEvolutionRole(value: string): value is XiaobaEvolutionRoleId {
  return ROLE_IDS.has(value);
}

export function assertEvolutionRole(value: string): asserts value is XiaobaEvolutionRoleId {
  if (!isXiaobaEvolutionRole(value)) {
    throw new RuntimeAdapterError(
      "role_blocked",
      `Role is not allowed in the embedded evolution Runtime: ${safeRoleLabel(value)}`
    );
  }
}

function manifestFromProbe(result: RuntimeProbeResult): XiaobaEvolutionRuntimeManifestV1 {
  if (result.status === "ready") {
    return baseManifest({
      status: "ready",
      ...(result.version && { version: result.version.slice(0, 120) }),
      detail: "Embedded XiaoBaOS is ready with all four evaluator/evolution roles.",
    });
  }
  return baseManifest({
    status: "blocked",
    ...(result.version && { version: result.version.slice(0, 120) }),
    ...(result.reason_code && { reason_code: result.reason_code }),
    detail: blockedDetail(result.reason_code),
  });
}

function baseManifest(
  status: Pick<
    XiaobaEvolutionRuntimeManifestV1,
    "status" | "detail" | "version" | "reason_code"
  >
): XiaobaEvolutionRuntimeManifestV1 {
  return {
    schema: "barena.xiaoba_evolution_runtime.v1",
    runtime_id: "xiaobaos-evolution",
    display_name: "XiaoBa Evolution Runtime",
    kind: "embedded_evolution",
    source: "configured",
    ...status,
    roles: XIAOBA_EVOLUTION_ROLE_DESCRIPTORS.map((role) => ({ ...role })),
    capabilities: {
      probe: true,
      role_turn: true,
      cancellation: true,
      telemetry: "native",
      target_runtime_hosted: false,
    },
  };
}

function blockedDetail(reason: RuntimeProbeResult["reason_code"]): string {
  if (reason === "binary_not_found") {
    return "The configured XiaoBaOS executable is unavailable to Barena Platform.";
  }
  if (reason === "role_not_found" || reason === "role_blocked") {
    return "XiaoBaOS is installed, but one or more required evolution roles are unavailable.";
  }
  if (reason === "cli_contract_missing") {
    return "The configured XiaoBaOS does not expose the required ordinary chat contract.";
  }
  if (reason === "config_invalid") {
    return "The embedded XiaoBaOS layout is not configured correctly.";
  }
  return "The embedded XiaoBaOS Runtime is currently blocked.";
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function safeRoleLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "?").slice(0, 80) || "<empty>";
}

function abortError(): Error {
  const error = new Error("Evolution Runtime request was cancelled.");
  error.name = "AbortError";
  return error;
}
