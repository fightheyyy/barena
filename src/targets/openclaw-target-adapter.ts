import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { boundaryEvent, writeBoundaryEvents } from "../e2e/boundary-trace";
import {
  AgentE2EReasonCode,
  BoundaryObservedFrom,
  BoundaryTraceEvent,
  RuntimeProbeResult,
  TargetAdapter,
  TargetInvocationRequest,
  TargetInvocationResult,
  WorkspaceChange,
} from "../e2e/types";
import { runProcess } from "../runtime/process-runner";
import { copyDirectory, ensureDir, hashDirectory, writeJson } from "../utils/fs";

export interface OpenClawTargetAdapterConfig {
  command?: string;
  baseArgs?: string[];
  envAllowlist?: string[];
  probeTimeoutMs?: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
}

interface OpenClawEnvelope {
  payloads: Array<{
    text?: unknown;
    mediaUrl?: unknown;
    mediaUrls?: unknown;
  }>;
  meta: Record<string, unknown>;
}

export class OpenClawTargetAdapter implements TargetAdapter {
  readonly id = "openclaw";
  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly envAllowlist: string[];
  private readonly probeTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;

  constructor(config: OpenClawTargetAdapterConfig = {}) {
    this.command = config.command ?? "openclaw";
    this.baseArgs = config.baseArgs ?? [];
    this.envAllowlist = config.envAllowlist ?? [];
    this.probeTimeoutMs = config.probeTimeoutMs ?? 5_000;
    this.maxOutputBytes = config.maxOutputBytes ?? 1024 * 1024;
    this.killGraceMs = config.killGraceMs ?? 500;
  }

  async probe(): Promise<RuntimeProbeResult> {
    const versionResult = await runProcess({
      command: this.command,
      args: [...this.baseArgs, "--version"],
      env: this.buildEnv([]),
      timeoutMs: this.probeTimeoutMs,
      killGraceMs: this.killGraceMs,
      maxOutputBytes: this.maxOutputBytes,
    });

    if (versionResult.spawnError) {
      return blockedProbe(
        this.command,
        versionResult.spawnError.code === "ENOENT" ? "binary_not_found" : "spawn_error",
        safeProcessError(versionResult.spawnError)
      );
    }
    if (versionResult.timedOut || versionResult.outputLimitExceeded || versionResult.exitCode !== 0) {
      return blockedProbe(
        this.command,
        versionResult.timedOut
          ? "target_timeout"
          : versionResult.outputLimitExceeded
            ? "output_limit_exceeded"
            : "binary_not_executable",
        "OpenClaw version preflight did not complete successfully."
      );
    }

    const helpResult = await runProcess({
      command: this.command,
      args: [...this.baseArgs, "agent", "--help"],
      env: this.buildEnv([]),
      timeoutMs: this.probeTimeoutMs,
      killGraceMs: this.killGraceMs,
      maxOutputBytes: this.maxOutputBytes,
    });
    const help = `${helpResult.stdout}\n${helpResult.stderr}`;
    const requiredFlags = ["--local", "--message-file", "--session-key", "--timeout", "--json"];
    const capabilities = requiredFlags.filter((flag) => help.includes(flag));

    const skillHelpResult = await runProcess({
      command: this.command,
      args: [...this.baseArgs, "skills", "check", "--help"],
      env: this.buildEnv([]),
      timeoutMs: this.probeTimeoutMs,
      killGraceMs: this.killGraceMs,
      maxOutputBytes: this.maxOutputBytes,
    });
    const skillHelp = `${skillHelpResult.stdout}\n${skillHelpResult.stderr}`;
    if (!skillHelpResult.spawnError && !skillHelpResult.timedOut && !skillHelpResult.outputLimitExceeded &&
        skillHelpResult.exitCode === 0 && skillHelp.includes("--agent") && skillHelp.includes("--json")) {
      capabilities.push("skills_check");
    }

    if (
      helpResult.spawnError ||
      helpResult.timedOut ||
      helpResult.outputLimitExceeded ||
      helpResult.exitCode !== 0 ||
      capabilities.length !== requiredFlags.length + 1
    ) {
      return {
        component: "openclaw-target",
        status: "blocked",
        reason_code: "cli_contract_missing",
        detail: "OpenClaw CLI does not expose the required local JSON agent and Skill eligibility contracts.",
        command: this.command,
        version: normalizedVersion(versionResult.stdout, versionResult.stderr),
        capabilities,
      };
    }

    return {
      component: "openclaw-target",
      status: "ready",
      detail: "OpenClaw local JSON CLI contract is available.",
      command: this.command,
      version: normalizedVersion(versionResult.stdout, versionResult.stderr),
      capabilities,
    };
  }

  async execute(request: TargetInvocationRequest): Promise<TargetInvocationResult> {
    ensureDir(request.workspace);
    const privateRoot = path.join(path.dirname(request.workspace), ".openclaw", request.attempt_id);
    const stateDir = path.join(privateRoot, "state");
    const configPath = path.join(privateRoot, "openclaw.json");
    const tempDir = path.join(privateRoot, "tmp");
    const promptPath = path.join(privateRoot, "prompt.txt");
    for (const directory of [privateRoot, stateDir, tempDir]) {
      ensureDir(directory);
      fs.chmodSync(directory, 0o700);
    }
    fs.writeFileSync(promptPath, request.prompt, { encoding: "utf8", mode: 0o600 });

    const agentId = request.target.agent ?? "main";
    const selectedSkills = request.skill.mode === "path" ? [request.skill.name] : [];
    try {
      if (request.skill.mode === "path") {
        if (!fs.existsSync(path.join(request.skill.source_path, "SKILL.md"))) {
          return this.blockedInvocation(request, "skill_manifest_invalid", "Candidate Skill does not contain SKILL.md.");
        }
        if (hashDirectory(request.skill.source_path) !== request.skill.fingerprint) {
          return this.blockedInvocation(request, "skill_stage_failed", "Candidate Skill changed after evaluation request creation.");
        }
        copyDirectory(request.skill.source_path, path.join(request.workspace, "skills", request.skill.name));
      }
      writeJson(configPath, {
        agents: {
          defaults: { workspace: request.workspace, skipBootstrap: true },
          list: [{ id: agentId, workspace: request.workspace, skills: selectedSkills }],
        },
      });
      fs.chmodSync(configPath, 0o600);
    } catch {
      return this.blockedInvocation(
        request,
        "openclaw_workspace_binding_failed",
        "Barena could not create the isolated OpenClaw workspace and exact Skill allowlist."
      );
    }

    const before = snapshotWorkspace(request.workspace);
    const sessionKey = `agent:${agentId}:barena-${safeId(request.run_id)}-${safeId(
      request.case_id
    )}-${safeId(request.attempt_id)}`;
    const args = [
      ...this.baseArgs,
      "agent",
      "--local",
      "--agent",
      agentId,
      "--session-key",
      sessionKey,
      "--message-file",
      promptPath,
      "--timeout",
      String(Math.max(1, Math.ceil(request.timeout_ms / 1000))),
      "--json",
    ];
    if (request.target.model) {
      args.push("--model", request.target.model);
    }
    if (request.target.thinking) {
      args.push("--thinking", request.target.thinking);
    }

    const forbiddenFlags = ["--deliver", "--to", "--channel", "--reply-to", "--reply-channel"];
    if (args.some((arg) => forbiddenFlags.includes(arg))) {
      return this.blockedInvocation(request, "config_invalid", "Delivery and reply flags are forbidden in E2E mode.");
    }

    const allowedEnvNames = [...new Set([...this.envAllowlist, ...(request.target.env_allowlist ?? [])])];
    const redactionValues = allowedEnvNames
      .map((name) => process.env[name])
      .filter((value): value is string => Boolean(value));
    const events: BoundaryTraceEvent[] = [
      boundaryEvent({
        runId: request.run_id,
        caseId: request.case_id,
        attemptId: request.attempt_id,
        component: this.id,
        observedFrom: "target_process",
        kind: "runtime_status",
        message: request.skill.mode === "path"
          ? `Staged candidate Skill ${request.skill.name} with an exact OpenClaw allowlist.`
          : "Bound baseline OpenClaw workspace with an empty Skill allowlist.",
        data: {
          skill_mode: request.skill.mode,
          skill_name: request.skill.mode === "path" ? request.skill.name : undefined,
          skill_fingerprint: request.skill.mode === "path" ? request.skill.fingerprint : undefined,
          workspace: request.workspace,
          allowlist: selectedSkills,
        },
      }),
      boundaryEvent({
        runId: request.run_id,
        caseId: request.case_id,
        attemptId: request.attempt_id,
        component: this.id,
        observedFrom: "target_input",
        kind: "user",
        message: redact(request.prompt, redactionValues),
        data: {
          transport: "message_file",
          prompt_sha256: sha256(request.prompt),
          session_key: sessionKey,
          env_names: allowedEnvNames,
          model: request.target.model,
          thinking: request.target.thinking,
        },
      }),
    ];

    const isolatedEnv = this.buildEnv(allowedEnvNames, {
      HOME: privateRoot,
      OPENCLAW_HOME: privateRoot,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_WORKSPACE_DIR: request.workspace,
      TMPDIR: tempDir,
      OPENCLAW_HIDE_BANNER: "1",
      NO_COLOR: "1",
      CI: "1",
    });
    const eligibility = await runProcess({
      command: this.command,
      args: [...this.baseArgs, "skills", "check", "--agent", agentId, "--json"],
      cwd: request.workspace,
      env: isolatedEnv,
      timeoutMs: this.probeTimeoutMs,
      killGraceMs: this.killGraceMs,
      maxOutputBytes: this.maxOutputBytes,
    });
    const eligibleNames = parseEligibleSkillNames(eligibility.stdout);
    if (eligibility.spawnError || eligibility.timedOut || eligibility.outputLimitExceeded || eligibility.exitCode !== 0 || !eligibleNames) {
      return this.blockedInvocation(
        request,
        "skill_eligibility_probe_failed",
        "OpenClaw Skill eligibility preflight did not return a trustworthy JSON result.",
        events
      );
    }
    const selectedVisible = request.skill.mode === "path" && eligibleNames.includes(request.skill.name);
    if (request.skill.mode === "path" && !selectedVisible) {
      return this.blockedInvocation(request, "skill_not_visible", `OpenClaw did not report ${request.skill.name} as eligible.`, events);
    }
    if (request.skill.mode === "none" && eligibleNames.length > 0) {
      return this.blockedInvocation(request, "baseline_skill_leak", "Baseline OpenClaw agent exposed one or more Skills.", events);
    }
    events.push(boundaryEvent({
      runId: request.run_id,
      caseId: request.case_id,
      attemptId: request.attempt_id,
      component: this.id,
      observedFrom: "target_process",
      kind: "runtime_status",
      message: request.skill.mode === "path"
        ? `OpenClaw reported candidate Skill ${request.skill.name} as eligible.`
        : "OpenClaw reported an empty eligible Skill set for baseline.",
      data: { eligible_skill_names: eligibleNames, selected_skill_visible: selectedVisible },
    }));

    const result = await runProcess({
      command: this.command,
      args,
      cwd: request.workspace,
      env: isolatedEnv,
      timeoutMs: request.timeout_ms + 2_000,
      killGraceMs: this.killGraceMs,
      maxOutputBytes: this.maxOutputBytes,
    });
    const stdout = redact(result.stdout, redactionValues);
    const stderr = redact(result.stderr, redactionValues);
    const after = snapshotWorkspace(request.workspace);
    const changes = diffWorkspace(before, after);

    if (stderr.trim()) {
      events.push(
        boundaryEvent({
          runId: request.run_id,
          caseId: request.case_id,
          attemptId: request.attempt_id,
          component: this.id,
          observedFrom: "target_stderr",
          kind: "runtime_status",
          message: stderr,
          data: { bytes: Buffer.byteLength(stderr) },
        })
      );
    }

    const parsed = parseEnvelope(stdout);
    if (parsed.envelope) {
      const payloadTexts = payloadTextsFrom(parsed.envelope).map((text) => redact(text, redactionValues));
      for (const text of payloadTexts) {
        events.push(
          boundaryEvent({
            runId: request.run_id,
            caseId: request.case_id,
            attemptId: request.attempt_id,
            component: this.id,
            observedFrom: "target_stdout",
            kind: "assistant",
            message: text,
          })
        );
      }
      events.push(
        boundaryEvent({
          runId: request.run_id,
          caseId: request.case_id,
          attemptId: request.attempt_id,
          component: this.id,
          observedFrom: "target_stdout",
          kind: "runtime_status",
          message: "Parsed complete OpenClaw JSON envelope.",
          data: {
            stdout_bytes: Buffer.byteLength(stdout),
            stdout_sha256: sha256(stdout),
            payload_count: parsed.envelope.payloads.length,
            meta: safeMeta(parsed.envelope.meta),
          },
        })
      );
    }

    for (const change of changes) {
      events.push(
        boundaryEvent({
          runId: request.run_id,
          caseId: request.case_id,
          attemptId: request.attempt_id,
          component: this.id,
          observedFrom: "workspace",
          kind: "artifact",
          message: `${change.change} workspace/${change.path}`,
          data: { ...change },
        })
      );
    }

    const classification = classifyResult(result, parsed.envelope, parsed.error, stderr);
    events.push(
      boundaryEvent({
        runId: request.run_id,
        caseId: request.case_id,
        attemptId: request.attempt_id,
        component: this.id,
        observedFrom: "target_process",
        kind: "runtime_status",
        message: classification.detail,
        data: {
          status: classification.status,
          reason_code: classification.reasonCode,
          exit_code: result.exitCode,
          signal: result.signal,
          duration_ms: result.durationMs,
          native_trace_available: false,
        },
      })
    );
    writeBoundaryEvents(request.trace_path, events);

    const envelope = parsed.envelope;
    const meta = envelope?.meta ?? {};
    const observationCoverage: BoundaryObservedFrom[] = ["target_input", "target_process", "workspace"];
    if (stdout.length) observationCoverage.push("target_stdout");
    if (stderr.length) observationCoverage.push("target_stderr");

    return {
      status: classification.status,
      reason_code: classification.reasonCode,
      detail: classification.detail,
      exit_code: result.exitCode,
      signal: result.signal,
      duration_ms: result.durationMs,
      transport: "embedded",
      payload_texts: envelope ? payloadTextsFrom(envelope).map((text) => redact(text, redactionValues)) : [],
      media_refs: envelope ? mediaRefsFrom(envelope) : [],
      provider: readString(readRecord(meta.agentMeta)?.provider),
      model: readString(readRecord(meta.agentMeta)?.model),
      session_id: readString(readRecord(meta.agentMeta)?.sessionId),
      native_trace_available: false,
      observation_coverage: observationCoverage,
      trace_path: request.trace_path,
      events,
      workspace_changes: changes,
    };
  }

  private buildEnv(names: string[], overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      ...overrides,
    };
    for (const name of names) {
      if (process.env[name] !== undefined) {
        env[name] = process.env[name];
      }
    }
    return env;
  }

  private blockedInvocation(
    request: TargetInvocationRequest,
    reasonCode: AgentE2EReasonCode,
    detail: string,
    previousEvents: BoundaryTraceEvent[] = []
  ): TargetInvocationResult {
    const event = boundaryEvent({
      runId: request.run_id,
      caseId: request.case_id,
      attemptId: request.attempt_id,
      component: this.id,
      observedFrom: "target_process",
      kind: "runtime_status",
      message: detail,
      data: { status: "blocked", reason_code: reasonCode },
    });
    const events = [...previousEvents, event];
    writeBoundaryEvents(request.trace_path, events);
    return {
      status: "blocked",
      reason_code: reasonCode,
      detail,
      exit_code: null,
      signal: null,
      duration_ms: 0,
      transport: "embedded",
      payload_texts: [],
      media_refs: [],
      native_trace_available: false,
      observation_coverage: ["target_process"],
      trace_path: request.trace_path,
      events,
      workspace_changes: [],
    };
  }
}

function parseEligibleSkillNames(stdout: string): string[] | undefined {
  try {
    const value = JSON.parse(stdout.trim()) as unknown;
    const record = readRecord(value);
    if (!record || !Array.isArray(record.eligible)) return undefined;
    const names: string[] = [];
    for (const item of record.eligible) {
      if (typeof item === "string") names.push(item);
      else {
        const name = readString(readRecord(item)?.name);
        if (name) names.push(name);
      }
    }
    return [...new Set(names)];
  } catch {
    return undefined;
  }
}

function blockedProbe(command: string, reasonCode: AgentE2EReasonCode, detail: string): RuntimeProbeResult {
  return {
    component: "openclaw-target",
    status: "blocked",
    reason_code: reasonCode,
    detail,
    command,
    capabilities: [],
  };
}

function safeProcessError(error: NodeJS.ErrnoException): string {
  if (error.code === "ENOENT") {
    return "OpenClaw binary was not found on PATH.";
  }
  return `OpenClaw process could not be started (${error.code ?? "unknown error"}).`;
}

function parseEnvelope(stdout: string): { envelope?: OpenClawEnvelope; error?: string } {
  if (!stdout.trim()) {
    return { error: "OpenClaw stdout was empty." };
  }
  try {
    const value = JSON.parse(stdout.trim()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: "OpenClaw stdout was not a JSON object." };
    }
    const record = value as Record<string, unknown>;
    if (!Array.isArray(record.payloads) || !record.payloads.every((item) => item && typeof item === "object")) {
      return { error: "OpenClaw JSON envelope has an incompatible payloads field." };
    }
    const meta = readRecord(record.meta);
    if (!meta) {
      return { error: "OpenClaw JSON envelope has an incompatible meta field." };
    }
    return { envelope: { payloads: record.payloads as OpenClawEnvelope["payloads"], meta } };
  } catch {
    return { error: "OpenClaw stdout was not exactly one valid JSON envelope." };
  }
}

function classifyResult(
  result: Awaited<ReturnType<typeof runProcess>>,
  envelope: OpenClawEnvelope | undefined,
  protocolError: string | undefined,
  stderr: string
): { status: TargetInvocationResult["status"]; reasonCode?: AgentE2EReasonCode; detail: string } {
  if (result.spawnError) {
    return {
      status: "blocked",
      reasonCode: result.spawnError.code === "ENOENT" ? "binary_not_found" : "spawn_error",
      detail: safeProcessError(result.spawnError),
    };
  }
  if (result.timedOut) {
    return { status: "blocked", reasonCode: "target_timeout", detail: "OpenClaw exceeded the hard deadline." };
  }
  if (result.outputLimitExceeded) {
    return {
      status: "blocked",
      reasonCode: "output_limit_exceeded",
      detail: "OpenClaw exceeded the captured output limit.",
    };
  }
  if (result.exitCode !== 0 && !envelope) {
    const reasonCode = preconditionReason(stderr) ?? "target_process_failed";
    return {
      status: "blocked",
      reasonCode,
      detail: `OpenClaw exited with code ${String(result.exitCode)} without a trustworthy successful terminal result.`,
    };
  }
  if (protocolError || !envelope) {
    return { status: "blocked", reasonCode: "target_protocol_error", detail: protocolError ?? "Missing envelope." };
  }
  if (result.exitCode !== 0) {
    return {
      status: "blocked",
      reasonCode: "target_process_failed",
      detail: `OpenClaw exited with code ${String(result.exitCode)} despite returning a JSON envelope.`,
    };
  }
  const metaErrorText = typeof envelope.meta.error === "string" ? envelope.meta.error : "";
  const precondition = preconditionReason(metaErrorText);
  if (precondition) {
    return {
      status: "blocked",
      reasonCode: precondition,
      detail: "OpenClaw reported a missing or invalid runtime precondition.",
    };
  }
  if (
    envelope.meta.error ||
    envelope.meta.timeoutPhase ||
    envelope.meta.livenessState === "abandoned" ||
    readRecord(envelope.meta.failureSignal)?.kind === "execution_denied"
  ) {
    return {
      status: "failed",
      reasonCode: "target_reported_error",
      detail: "OpenClaw returned a valid envelope containing a terminal failure signal.",
    };
  }
  return { status: "completed", detail: "OpenClaw completed; artifact assertions still determine case success." };
}

function preconditionReason(message: string): AgentE2EReasonCode | undefined {
  if (/(credential|api[ _-]?key|auth(?:entication|orization)?|secret|token)/i.test(message)) {
    return "credential_missing";
  }
  if (/(config|configuration|profile)/i.test(message)) {
    return "config_invalid";
  }
  return undefined;
}

function payloadTextsFrom(envelope: OpenClawEnvelope): string[] {
  return envelope.payloads.map((payload) => payload.text).filter((value): value is string => typeof value === "string");
}

function mediaRefsFrom(envelope: OpenClawEnvelope): string[] {
  const refs: string[] = [];
  for (const payload of envelope.payloads) {
    if (typeof payload.mediaUrl === "string") refs.push(payload.mediaUrl);
    if (Array.isArray(payload.mediaUrls)) {
      refs.push(...payload.mediaUrls.filter((value): value is string => typeof value === "string"));
    }
  }
  return refs;
}

function safeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  return {
    durationMs: meta.durationMs,
    agentMeta: meta.agentMeta,
    error: meta.error,
    aborted: meta.aborted,
    timeoutPhase: meta.timeoutPhase,
    livenessState: meta.livenessState,
    stopReason: meta.stopReason,
    failureSignal: meta.failureSignal,
    toolSummary: meta.toolSummary,
    executionTrace: meta.executionTrace,
  };
}

function snapshotWorkspace(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  if (!fs.existsSync(root)) return snapshot;
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        snapshot.set(path.relative(root, fullPath), sha256(fs.readFileSync(fullPath)));
      }
    }
  };
  walk(root);
  return snapshot;
}

function diffWorkspace(before: Map<string, string>, after: Map<string, string>): WorkspaceChange[] {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.flatMap((relativePath): WorkspaceChange[] => {
    const oldHash = before.get(relativePath);
    const newHash = after.get(relativePath);
    if (oldHash === newHash) return [];
    if (!oldHash) return [{ path: relativePath, change: "created", sha256_after: newHash }];
    if (!newHash) return [{ path: relativePath, change: "deleted", sha256_before: oldHash }];
    return [{ path: relativePath, change: "modified", sha256_before: oldHash, sha256_after: newHash }];
  });
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function redact(value: string, secrets: string[]): string {
  return secrets.reduce((redacted, secret) => (secret ? redacted.split(secret).join("[REDACTED]") : redacted), value);
}

function normalizedVersion(stdout: string, stderr: string): string | undefined {
  const lines = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1];
}
