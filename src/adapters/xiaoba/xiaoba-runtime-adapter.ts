import fs from "node:fs";
import path from "node:path";
import { TraceEvent } from "../../domain/types";
import { appendNdjson, ensureDir } from "../../utils/fs";
import { RuntimeAdapter, RuntimeRunRequest, RuntimeRunResult } from "./types";

export class XiaoBaRuntimeAdapter implements RuntimeAdapter {
  run(request: RuntimeRunRequest): RuntimeRunResult {
    const skillPath = path.join(request.subject.paths.subject_root, "SKILL.md");
    const agentTargetPath = path.join(request.subject.paths.subject_root, "BARENA_AGENT_TARGET.md");
    const skillText = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, "utf8") : "";
    const agentTargetText = fs.existsSync(agentTargetPath) ? fs.readFileSync(agentTargetPath, "utf8") : "";
    const subjectText = [skillText, agentTargetText].filter((value) => value.trim()).join("\n\n");
    const events: TraceEvent[] = [];
    const tracePath = request.tracePath ?? path.join(request.run.paths.traces, "trace.ndjson");
    const artifactsRoot = request.artifactsRoot ?? request.run.paths.artifacts;
    ensureDir(artifactsRoot);
    const unsafe = /BARENA_UNSAFE|rm\s+-rf|send_text\s*\(/i.test(subjectText);
    const suppressArtifact = /BARENA_NO_ARTIFACT/i.test(subjectText);
    const blocked = !subjectText.trim();

    for (const scenario of request.scenarios) {
      events.push(event(request.run.run_id, scenario.scenario_id, "user", scenario.prompt));

      if (blocked) {
        events.push(
          event(request.run.run_id, scenario.scenario_id, "runtime_status", "Missing SKILL.md content", {
            status: "blocked",
            subject_type: request.subject.type,
          })
        );
        continue;
      }

      events.push(
        event(
          request.run.run_id,
          scenario.scenario_id,
          "assistant",
          request.subject.type === "agent"
            ? "I will exercise the agent target profile and produce CI evidence."
            : "I will use the candidate capability and produce evidence.",
          {
            claimed_complete: false,
            subject_type: request.subject.type,
            agent_target: request.subject.metadata.agent_target ?? undefined,
          }
        )
      );

      if (unsafe) {
        events.push(
          event(request.run.run_id, scenario.scenario_id, "tool_call", "Unsafe tool call requested by subject instructions", {
            unsafe: true,
          })
        );
        events.push(
          event(request.run.run_id, scenario.scenario_id, "runtime_status", "Run stopped before executing unsafe behavior", {
            status: "unsafe",
            unsafe: true,
          })
        );
        continue;
      }

      events.push(
        event(request.run.run_id, scenario.scenario_id, "tool_call", "create_artifact", {
          tool: "artifact_writer",
        })
      );

      if (!suppressArtifact) {
        const artifactPath = path.join(artifactsRoot, `${scenario.scenario_id}.txt`);
        fs.writeFileSync(
          artifactPath,
          artifactText(request, scenario.prompt),
          "utf8"
        );
        events.push(
          event(request.run.run_id, scenario.scenario_id, "artifact", `Created artifact ${artifactPath}`, {
            artifact_path: artifactPath,
          })
        );
      }

      events.push(
        event(request.run.run_id, scenario.scenario_id, "assistant", "Done. Evidence is attached in the run artifacts.", {
          claimed_complete: true,
        })
      );
      events.push(
        event(request.run.run_id, scenario.scenario_id, "runtime_status", "Scenario completed", {
          status: "completed",
        })
      );
    }

    appendNdjson(tracePath, events);
    return { tracePath, events };
  }
}

function artifactText(request: RuntimeRunRequest, scenarioPrompt: string): string {
  const target = request.subject.metadata.agent_target as
    | {
        target_id?: string;
        display_name?: string;
        category?: string;
        ci_focus?: string[];
        risk_focus?: string[];
      }
    | undefined;

  const targetLines = target
    ? [
        `Agent target: ${target.display_name ?? target.target_id}`,
        `Category: ${target.category ?? "unknown"}`,
        `CI focus: ${(target.ci_focus ?? []).join(", ")}`,
        `Risk focus: ${(target.risk_focus ?? []).join(", ")}`,
      ]
    : [];

  return [
    `Barena artifact for ${request.subject.subject_id}`,
    `Subject type: ${request.subject.type}`,
    `Attempt: ${request.attemptId ?? "initial"}`,
    `Scenario: ${scenarioPrompt}`,
    ...targetLines,
    "",
  ].join("\n");
}

function event(
  runId: string,
  scenarioId: string,
  kind: TraceEvent["kind"],
  message: string,
  data?: Record<string, unknown>
): TraceEvent {
  return {
    timestamp: new Date().toISOString(),
    run_id: runId,
    scenario_id: scenarioId,
    kind,
    message,
    data,
  };
}
