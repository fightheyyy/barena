import { RunManifest, SubjectManifest, TraceEvent, UserScenario } from "../../domain/types";

export interface RuntimeRunRequest {
  subject: SubjectManifest;
  run: RunManifest;
  scenarios: UserScenario[];
  tracePath?: string;
  artifactsRoot?: string;
  attemptId?: string;
}

export interface RuntimeRunResult {
  tracePath: string;
  events: TraceEvent[];
}

export interface RuntimeAdapter {
  run(request: RuntimeRunRequest): RuntimeRunResult;
}

export interface XiaoBaAdapterConfig {
  source_root?: string;
  mode: "deterministic-scaffold" | "agent-session-bridge";
}
