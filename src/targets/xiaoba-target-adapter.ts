import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { boundaryEvent, writeBoundaryEvents } from "../e2e/boundary-trace";
import type {
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
import { appendNdjson, copyDirectory, ensureDir, hashDirectory } from "../utils/fs";

export interface XiaobaTargetAdapterConfig {
  command?: string;
  baseArgs?: string[];
  projectRoot?: string;
  rolesRoot?: string;
  envAllowlist?: string[];
  probeTimeoutMs?: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
}

/**
 * Runs XiaobaOS only through its normal one-shot chat surface.
 *
 * Barena owns cases, attempts, evidence verification, aggregation, and release
 * decisions. This adapter deliberately has no dependency on XiaobaOS Arena.
 */
export class XiaobaTargetAdapter implements TargetAdapter {
  readonly id = "xiaobaos";
  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly projectRoot?: string;
  private readonly rolesRoot?: string;
  private readonly envAllowlist: string[];
  private readonly envAllowlistConfigured: boolean;
  private readonly probeTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;

  constructor(config: XiaobaTargetAdapterConfig = {}) {
    const command = config.command ?? "xiaoba";
    this.command = command.includes(path.sep) ? path.resolve(command) : command;
    this.baseArgs = config.baseArgs ?? [];
    this.projectRoot = config.projectRoot ? path.resolve(config.projectRoot) : undefined;
    this.rolesRoot = config.rolesRoot ? path.resolve(config.rolesRoot) : undefined;
    this.envAllowlist = config.envAllowlist ?? [];
    this.envAllowlistConfigured = config.envAllowlist !== undefined;
    this.probeTimeoutMs = config.probeTimeoutMs ?? 5_000;
    this.maxOutputBytes = config.maxOutputBytes ?? 1024 * 1024;
    this.killGraceMs = config.killGraceMs ?? 500;
    assertNoArenaArgs(this.baseArgs);
  }

  async probe(): Promise<RuntimeProbeResult> {
    const layoutIssue = this.configuredLayoutIssue();
    if (layoutIssue) return blockedProbe(this.command, "config_invalid", layoutIssue);

    const version = await runProcess({
      command: this.command,
      args: [...this.baseArgs, "--version"],
      env: this.buildEnv([]),
      timeoutMs: this.probeTimeoutMs,
      killGraceMs: this.killGraceMs,
      maxOutputBytes: this.maxOutputBytes,
    });
    if (version.spawnError) {
      return blockedProbe(
        this.command,
        version.spawnError.code === "ENOENT" ? "xiaoba_binary_not_found" : "spawn_error",
        version.spawnError.code === "ENOENT"
          ? "XiaobaOS CLI binary was not found on PATH."
          : `XiaobaOS CLI could not start (${version.spawnError.code ?? "unknown error"}).`
      );
    }
    if (version.timedOut || version.outputLimitExceeded || version.exitCode !== 0) {
      return blockedProbe(
        this.command,
        version.timedOut
          ? "target_timeout"
          : version.outputLimitExceeded
            ? "output_limit_exceeded"
            : "binary_not_executable",
        "XiaobaOS version preflight did not complete successfully."
      );
    }

    const help = await runProcess({
      command: this.command,
      args: [...this.baseArgs, "chat", "--help"],
      env: this.buildEnv([]),
      timeoutMs: this.probeTimeoutMs,
      killGraceMs: this.killGraceMs,
      maxOutputBytes: this.maxOutputBytes,
    });
    const helpText = `${help.stdout}\n${help.stderr}`;
    const required = ["--role", "--message", "--skill"];
    const capabilities = required.filter((flag) => helpText.includes(flag));
    if (help.spawnError || help.timedOut || help.outputLimitExceeded || help.exitCode !== 0 ||
        capabilities.length !== required.length) {
      return {
        component: "xiaoba-target",
        status: "blocked",
        reason_code: "cli_contract_missing",
        detail: "XiaobaOS CLI does not expose the required ordinary one-shot chat contract.",
        command: this.command,
        version: normalizedVersion(version.stdout, version.stderr),
        capabilities,
      };
    }
    return {
      component: "xiaoba-target",
      status: "ready",
      detail: "XiaobaOS ordinary one-shot chat contract is available; Barena remains the evaluator.",
      command: this.command,
      version: normalizedVersion(version.stdout, version.stderr),
      capabilities: ["ordinary_chat", "role_selection", "explicit_skill_activation"],
    };
  }

  async execute(request: TargetInvocationRequest): Promise<TargetInvocationResult> {
    ensureDir(request.workspace);
    const role = request.target.agent;
    if (!role || !isSafeId(role)) {
      return this.blockedInvocation(request, "config_invalid", "XiaobaOS cases require target.agent as a safe Role ID.");
    }
    const layoutIssue = this.configuredLayoutIssue(role);
    if (layoutIssue) return this.blockedInvocation(request, "config_invalid", layoutIssue);

    const privateRoot = path.join(path.dirname(request.workspace), ".xiaoba", safeId(request.attempt_id));
    const skillsRoot = path.join(privateRoot, "skills");
    const tempRoot = path.join(privateRoot, "tmp");
    for (const directory of [privateRoot, skillsRoot, tempRoot]) {
      ensureDir(directory);
      fs.chmodSync(directory, 0o700);
    }

    const events: BoundaryTraceEvent[] = [];
    try {
      const installedSkillsRoot = this.projectRoot ? path.join(this.projectRoot, "skills") : undefined;
      if (installedSkillsRoot && fs.existsSync(installedSkillsRoot)) {
        hashDirectory(installedSkillsRoot);
        copyDirectory(installedSkillsRoot, skillsRoot);
        const excludedName = request.skill.mode === "path" ? request.skill.name : request.skill.excluded_name;
        if (excludedName) {
          const replacedCandidate = path.join(skillsRoot, excludedName);
          if (fs.existsSync(replacedCandidate)) fs.rmSync(replacedCandidate, { recursive: true, force: true });
        }
      }
      if (request.skill.mode === "path") {
        if (!fs.existsSync(path.join(request.skill.source_path, "SKILL.md"))) {
          return this.blockedInvocation(request, "skill_manifest_invalid", "Candidate Skill does not contain SKILL.md.");
        }
        if (hashDirectory(request.skill.source_path) !== request.skill.fingerprint) {
          return this.blockedInvocation(request, "skill_stage_failed", "Candidate Skill changed after evaluation request creation.");
        }
        copyDirectory(request.skill.source_path, path.join(skillsRoot, request.skill.name));
      }
    } catch {
      return this.blockedInvocation(request, "skill_stage_failed", "Barena could not stage the candidate Skill in the isolated XiaobaOS Skill root.");
    }

    const requestedEnvNames = request.target.env_allowlist ?? [];
    if (this.envAllowlistConfigured) {
      const denied = requestedEnvNames.filter(
        (name) => !this.envAllowlist.includes(name)
      );
      if (denied.length > 0) {
        return this.blockedInvocation(
          request,
          "config_invalid",
          `XiaobaOS Case requested environment names outside the Runner allowlist: ${denied.sort().join(", ")}.`
        );
      }
    }
    const envNames = this.envAllowlistConfigured
      ? [...this.envAllowlist]
      : [...new Set(requestedEnvNames)];
    const secrets = envNames.map((name) => process.env[name]).filter((value): value is string => Boolean(value));
    const attemptCorrelationId = `barena-${safeId(request.run_id)}-${safeId(request.case_id)}-${safeId(request.attempt_id)}`;
    const args = [
      ...this.baseArgs,
      "chat",
      "--role",
      role,
      "--message",
      request.prompt,
      ...(request.skill.mode === "path" ? ["--skill", request.skill.name] : []),
    ];
    assertNoArenaArgs(args);

    events.push(
      boundaryEvent({
        runId: request.run_id,
        caseId: request.case_id,
        attemptId: request.attempt_id,
        component: this.id,
        observedFrom: "target_process",
        kind: "runtime_status",
        message: request.skill.mode === "path"
          ? `Staged candidate Skill ${request.skill.name} over an isolated snapshot of XiaobaOS base Skills.`
          : "Bound baseline XiaobaOS execution to an isolated snapshot of its installed base Skills.",
        data: {
          evaluator_owner: "barena",
          target_surface: "xiaoba chat",
          role,
          skill_mode: request.skill.mode,
          skill_name: request.skill.mode === "path" ? request.skill.name : undefined,
          excluded_skill_name: request.skill.mode === "none" ? request.skill.excluded_name : undefined,
          skill_fingerprint: request.skill.mode === "path" ? request.skill.fingerprint : undefined,
          env_names: envNames,
          attempt_correlation_id: attemptCorrelationId,
        },
      }),
      boundaryEvent({
        runId: request.run_id,
        caseId: request.case_id,
        attemptId: request.attempt_id,
        component: this.id,
        observedFrom: "target_input",
        kind: "user",
        message: redact(request.prompt, secrets),
        data: { transport: "argv", prompt_sha256: sha256(request.prompt), role, attempt_correlation_id: attemptCorrelationId },
      })
    );

    const startedAt = new Date();
    const before = snapshotWorkspace(request.workspace);
    const result = await runProcess({
      command: this.command,
      args,
      cwd: request.workspace,
      env: this.buildEnv(envNames, {
        ...(this.projectRoot && { XIAOBA_PROJECT_ROOT: this.projectRoot }),
        ...(this.rolesRoot && { XIAOBA_ROLES_ROOT: this.rolesRoot }),
        XIAOBA_SKILLS_ROOT: skillsRoot,
        TMPDIR: tempRoot,
        NO_COLOR: "1",
        CI: "1",
      }),
      timeoutMs: request.timeout_ms,
      killGraceMs: this.killGraceMs,
      maxOutputBytes: this.maxOutputBytes,
    });
    const stdout = redact(stripAnsi(result.stdout), secrets);
    const stderr = redact(stripAnsi(result.stderr), secrets);
    const after = snapshotWorkspace(request.workspace);
    const changes = diffWorkspace(before, after);
    const nativeTraceRefs = findNativeTraceFiles(request.workspace);
    const nativeSessionId = readNativeSessionId(nativeTraceRefs);

    if (stdout.trim()) {
      events.push(boundaryEvent({
        runId: request.run_id,
        caseId: request.case_id,
        attemptId: request.attempt_id,
        component: this.id,
        observedFrom: "target_stdout",
        kind: "assistant",
        message: stdout.trim(),
        data: { bytes: Buffer.byteLength(stdout), sha256: sha256(stdout) },
      }));
    }
    if (stderr.trim()) {
      events.push(boundaryEvent({
        runId: request.run_id,
        caseId: request.case_id,
        attemptId: request.attempt_id,
        component: this.id,
        observedFrom: "target_stderr",
        kind: "runtime_status",
        message: stderr.trim(),
        data: { bytes: Buffer.byteLength(stderr) },
      }));
    }
    for (const change of changes) {
      events.push(boundaryEvent({
        runId: request.run_id,
        caseId: request.case_id,
        attemptId: request.attempt_id,
        component: this.id,
        observedFrom: "workspace",
        kind: "artifact",
        message: `${change.change} workspace/${change.path}`,
        data: { ...change },
      }));
    }

    const classification = classify(result, `${stdout}\n${stderr}`);
    events.push(boundaryEvent({
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
        native_trace_available: nativeTraceRefs.length > 0,
        native_trace_refs: nativeTraceRefs,
      },
    }));
    writeBoundaryEvents(request.trace_path, events);
    const boundaryTraceRef = writeBoundarySpan(
      request,
      startedAt,
      classification.status === "completed" ? "OK" : "ERROR",
      {
        "barena.target.status": classification.status,
        "barena.target.exit_code": result.exitCode ?? -1,
      }
    );

    const coverage: BoundaryObservedFrom[] = ["target_input", "target_process", "workspace"];
    if (stdout.length) coverage.push("target_stdout");
    if (stderr.length) coverage.push("target_stderr");
    return {
      status: classification.status,
      ...(classification.reasonCode && { reason_code: classification.reasonCode }),
      detail: classification.detail,
      exit_code: result.exitCode,
      signal: result.signal,
      duration_ms: result.durationMs,
      transport: "embedded",
      payload_texts: stdout.trim() ? [stdout.trim()] : [],
      media_refs: [],
      model: request.target.model,
      session_id: nativeSessionId ?? attemptCorrelationId,
      native_trace_available: nativeTraceRefs.length > 0,
      native_trace_refs: nativeTraceRefs,
      boundary_trace_refs: [boundaryTraceRef],
      observation_coverage: coverage,
      trace_path: request.trace_path,
      events,
      workspace_changes: changes,
    };
  }

  private buildEnv(names: string[], overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: process.env.LANG, ...overrides };
    for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
    return env;
  }

  private configuredLayoutIssue(role?: string): string | undefined {
    if (this.projectRoot && !isDirectory(this.projectRoot)) {
      return `Configured XiaobaOS project root is not a directory: ${this.projectRoot}`;
    }

    const effectiveRolesRoot = this.rolesRoot ?? (this.projectRoot ? path.join(this.projectRoot, "roles") : undefined);
    if (!effectiveRolesRoot) return undefined;
    if (!isDirectory(effectiveRolesRoot)) {
      return `Configured XiaobaOS roles root is not a directory: ${effectiveRolesRoot}`;
    }
    if (!role) return undefined;

    const roleDirectory = resolveRoleDirectory(effectiveRolesRoot, role);
    if (!roleDirectory) {
      return `Configured XiaobaOS Role does not exist: ${role}`;
    }
    const manifestPath = path.join(roleDirectory, "role.json");
    if (!isRegularFile(manifestPath)) {
      return `Configured XiaobaOS Role is missing role.json: ${role}`;
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
        return `Configured XiaobaOS Role has an invalid role.json object: ${role}`;
      }
      if ((manifest as Record<string, unknown>).status === "blocked") {
        return `Configured XiaobaOS Role is blocked: ${role}`;
      }
    } catch {
      return `Configured XiaobaOS Role has invalid role.json: ${role}`;
    }
    return undefined;
  }

  private blockedInvocation(
    request: TargetInvocationRequest,
    reasonCode: AgentE2EReasonCode,
    detail: string
  ): TargetInvocationResult {
    const events = [boundaryEvent({
      runId: request.run_id,
      caseId: request.case_id,
      attemptId: request.attempt_id,
      component: this.id,
      observedFrom: "target_process",
      kind: "runtime_status",
      message: detail,
      data: { status: "blocked", reason_code: reasonCode },
    })];
    writeBoundaryEvents(request.trace_path, events);
    const boundaryTraceRef = writeBoundarySpan(
      request,
      new Date(),
      "ERROR",
      {
        "barena.target.status": "blocked",
        "barena.target.reason_code": reasonCode,
      }
    );
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
      native_trace_refs: [],
      boundary_trace_refs: [boundaryTraceRef],
      observation_coverage: ["target_process"],
      trace_path: request.trace_path,
      events,
      workspace_changes: [],
    };
  }
}

function writeBoundarySpan(
  request: TargetInvocationRequest,
  startedAt: Date,
  status: "OK" | "ERROR",
  attributes: Record<string, string | number | boolean>
): string {
  const traceId =
    request.trace_id && /^[a-f0-9]{32}$/.test(request.trace_id)
      ? request.trace_id
      : crypto.randomBytes(16).toString("hex");
  const traceRef = boundaryOTelRef(request.trace_path);
  appendNdjson(traceRef, [
    {
      schema: "barena.boundary_otel_span.v1",
      trace_id: traceId,
      span_id: crypto.randomBytes(8).toString("hex"),
      name: "barena.xiaoba.replay",
      start_time: startedAt.toISOString(),
      end_time: new Date().toISOString(),
      status,
      attributes: {
        "barena.run.id": request.run_id,
        "barena.case.id": request.case_id,
        "barena.attempt.id": request.attempt_id,
        "barena.provenance.layer": "adapter_boundary",
        "barena.target.runtime": "xiaobaos",
        ...attributes,
      },
    },
  ]);
  return traceRef;
}

function boundaryOTelRef(tracePath: string): string {
  const directory = path.dirname(tracePath);
  const base = path.basename(tracePath, path.extname(tracePath));
  return path.join(directory, `${base}-otel.ndjson`);
}

function classify(
  result: Awaited<ReturnType<typeof runProcess>>,
  output: string
): { status: TargetInvocationResult["status"]; reasonCode?: AgentE2EReasonCode; detail: string } {
  if (result.spawnError) {
    return {
      status: "blocked",
      reasonCode: result.spawnError.code === "ENOENT" ? "xiaoba_binary_not_found" : "spawn_error",
      detail: result.spawnError.code === "ENOENT"
        ? "XiaobaOS CLI binary was not found on PATH."
        : `XiaobaOS CLI could not start (${result.spawnError.code ?? "unknown error"}).`,
    };
  }
  if (result.timedOut) return { status: "blocked", reasonCode: "target_timeout", detail: "XiaobaOS chat exceeded the hard deadline." };
  if (result.outputLimitExceeded) {
    return { status: "blocked", reasonCode: "output_limit_exceeded", detail: "XiaobaOS chat exceeded the captured output limit." };
  }
  if (result.exitCode !== 0) {
    const reasonCode: AgentE2EReasonCode = /(credential|api[ _-]?key|auth|secret|token)/i.test(output)
      ? "credential_missing"
      : /(config|configuration|profile)/i.test(output)
        ? "config_invalid"
        : "target_process_failed";
    return { status: "blocked", reasonCode, detail: `XiaobaOS chat exited with code ${String(result.exitCode)}.` };
  }
  return { status: "completed", detail: "XiaobaOS chat completed; Barena artifact assertions determine case success." };
}

function blockedProbe(command: string, reasonCode: AgentE2EReasonCode, detail: string): RuntimeProbeResult {
  return { component: "xiaoba-target", status: "blocked", reason_code: reasonCode, detail, command, capabilities: [] };
}

function assertNoArenaArgs(args: string[]): void {
  if (args.some((arg) => arg.trim().toLowerCase() === "arena")) {
    throw new Error("XiaobaOS target adapter may not invoke XiaobaOS Arena");
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveRoleDirectory(rolesRoot: string, requestedRole: string): string | undefined {
  const normalized = normalizeRoleId(requestedRole);
  const match = fs.readdirSync(rolesRoot, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && normalizeRoleId(entry.name) === normalized);
  return match ? path.join(rolesRoot, match.name) : undefined;
}

function normalizeRoleId(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

function findNativeTraceFiles(root: string): string[] {
  const refs: string[] = [];
  if (!fs.existsSync(root)) return refs;
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile() && entry.name === "traces.jsonl") refs.push(fullPath);
    }
  };
  walk(root);
  return refs.sort();
}

function readNativeSessionId(traceRefs: string[]): string | undefined {
  for (const traceRef of traceRefs) {
    try {
      for (const line of fs.readFileSync(traceRef, "utf8").split(/\r?\n/).filter(Boolean)) {
        const row = JSON.parse(line) as unknown;
        if (row && typeof row === "object" && !Array.isArray(row)) {
          const sessionId = (row as Record<string, unknown>).session_id;
          if (typeof sessionId === "string" && sessionId.trim()) return sessionId;
        }
      }
    } catch {
      // A native trace is optional evidence; unreadable rows do not become inferred session identity.
    }
  }
  return undefined;
}

function snapshotWorkspace(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  if (!fs.existsSync(root)) return snapshot;
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) snapshot.set(path.relative(root, fullPath), sha256(fs.readFileSync(fullPath)));
    }
  };
  walk(root);
  return snapshot;
}

function diffWorkspace(before: Map<string, string>, after: Map<string, string>): WorkspaceChange[] {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  return names.flatMap((relativePath): WorkspaceChange[] => {
    const oldHash = before.get(relativePath);
    const newHash = after.get(relativePath);
    if (oldHash === newHash) return [];
    if (!oldHash) return [{ path: relativePath, change: "created", sha256_after: newHash }];
    if (!newHash) return [{ path: relativePath, change: "deleted", sha256_before: oldHash }];
    return [{ path: relativePath, change: "modified", sha256_before: oldHash, sha256_after: newHash }];
  });
}

function stripAnsi(value: string): string {
  return value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)?)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");
}

function redact(value: string, secrets: string[]): string {
  return secrets.reduce((redacted, secret) => secret ? redacted.split(secret).join("[REDACTED]") : redacted, value);
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 100);
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

function normalizedVersion(stdout: string, stderr: string): string | undefined {
  return `${stdout}\n${stderr}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
}
