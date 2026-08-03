import type {
  RuntimeReasonCode,
  RuntimeTelemetryConfig,
  RuntimeTurnResult,
} from "../runtime-adapters";

export const XIAOBA_EVOLUTION_ROLES = [
  "user-cat",
  "inspector-cat",
  "reviewer-cat",
  "evolution-cat",
] as const;

export type XiaobaEvolutionRoleId = (typeof XIAOBA_EVOLUTION_ROLES)[number];

export interface XiaobaEvolutionRoleDescriptor {
  id: XiaobaEvolutionRoleId;
  display_name: string;
  responsibility: string;
  output: string;
}

export interface XiaobaEvolutionRuntimeManifestV1 {
  schema: "barena.xiaoba_evolution_runtime.v1";
  runtime_id: "xiaobaos-evolution";
  display_name: "XiaoBa Evolution Runtime";
  kind: "embedded_evolution";
  source: "configured";
  status: "ready" | "blocked";
  version?: string;
  reason_code?: RuntimeReasonCode | "runtime_error" | "not_configured";
  detail: string;
  roles: XiaobaEvolutionRoleDescriptor[];
  capabilities: {
    probe: true;
    role_turn: true;
    cancellation: true;
    telemetry: "native";
    target_runtime_hosted: false;
  };
}

export interface XiaobaEvolutionRuntimeConfigV1 {
  command?: string;
  project_root?: string;
  roles_root?: string;
  skills_root?: string;
  env_allowlist?: string[];
  probe_timeout_ms?: number;
  max_output_bytes?: number;
  kill_grace_ms?: number;
}

export interface XiaobaEvolutionRoleTurnRequest {
  request_id: string;
  run_id: string;
  role: XiaobaEvolutionRoleId;
  prompt: string;
  workspace: string;
  timeout_ms: number;
  telemetry?: RuntimeTelemetryConfig;
}

export type XiaobaEvolutionWorkerRequestV1 =
  | {
      schema: "barena.xiaoba_evolution_request.v1";
      request_id: string;
      operation: "probe";
      runtime?: XiaobaEvolutionRuntimeConfigV1;
    }
  | ({
      schema: "barena.xiaoba_evolution_request.v1";
      operation: "turn";
      runtime?: XiaobaEvolutionRuntimeConfigV1;
    } & XiaobaEvolutionRoleTurnRequest);

export type XiaobaEvolutionWorkerResponseV1 =
  | {
      schema: "barena.xiaoba_evolution_response.v1";
      request_id: string;
      operation: "probe";
      status: "ok";
      runtime: XiaobaEvolutionRuntimeManifestV1;
    }
  | {
      schema: "barena.xiaoba_evolution_response.v1";
      request_id: string;
      operation: "turn";
      status: "ok";
      result: RuntimeTurnResult;
    }
  | {
      schema: "barena.xiaoba_evolution_response.v1";
      request_id: string;
      operation: "probe" | "turn" | "unknown";
      status: "error";
      error: {
        code: "invalid_request" | "runtime_error";
        detail: string;
      };
    };
