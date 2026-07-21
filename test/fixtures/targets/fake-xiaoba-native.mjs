#!/usr/bin/env node

// Future-contract simulator only. Stock XiaobaOS 0.2.0 does not expose this
// additive live contract and must remain fail-closed in Barena.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);

try {
  if (argv.length === 1 && argv[0] === "--version") {
    process.stdout.write("0.2.0\n");
  } else if (matches(argv, ["arena", "import", "skill"]) && argv.includes("--help")) {
    process.stdout.write("Usage: xiaoba arena import skill <path>\n");
  } else if (matches(argv, ["arena", "snapshot", "role"]) && argv.includes("--help")) {
    process.stdout.write("Usage: xiaoba arena snapshot role <role-id>\n");
  } else if (matches(argv, ["arena", "runtime", "prepare"]) && argv.includes("--help")) {
    process.stdout.write("Usage: xiaoba arena runtime prepare --mode base_skill|role_skill|role\n");
  } else if (matches(argv, ["arena", "live-contract"]) && argv.includes("--help")) {
    process.stdout.write("Usage: xiaoba arena live-contract --json\n");
  } else if (matches(argv, ["arena", "runtime", "contract"]) && argv.includes("--help")) {
    process.stdout.write("Usage: xiaoba arena runtime contract --json\n");
  } else if (matches(argv, ["arena", "run", "execute"]) && argv.includes("--help")) {
    printExecuteHelp();
  } else if (argv.length === 2 && matches(argv, ["arena"]) && argv.includes("--help")) {
    process.stdout.write("Arena commands: skill import snapshot run runtime\n");
  } else if (matches(argv, ["arena", "live-contract"])) {
    printJson(futureLiveRuntimeContract());
  } else if (matches(argv, ["arena", "runtime", "contract"])) {
    printJson(futureLiveRuntimeContract());
  } else if (matches(argv, ["arena", "import", "skill"])) {
    printJson(importSkill(requiredPositional(argv, 3, "skill path")));
  } else if (matches(argv, ["arena", "snapshot", "role"])) {
    printJson(snapshotRole(requiredPositional(argv, 3, "role id")));
  } else if (matches(argv, ["arena", "run", "execute"])) {
    printJson(executeArenaRun(parseFlags(argv.slice(3))));
    if (String(process.env.FAKE_XIAOBA_BEHAVIOR || "").trim().toLowerCase() === "post_call_failure") process.exit(70);
  } else {
    fail(`Unsupported fake XiaoBa command: ${argv.join(" ")}`, 64);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), 1);
}

function printExecuteHelp() {
  process.stdout.write(`Usage: xiaoba arena run execute [options]

Run UserCat -> InspectorCat -> ReviewerCat in a clean sandboxed Arena runtime
and output a scorecard

Options:
  --mode <mode>                  base_skill|role_skill|role
  --subject <id>                 Arena subject id or path to arena-manifest.json
  --run-id <id>                  run id
  --target-role <id>             required for role_skill and role modes
  --surface <name>               surface used by UserCat, default pet
  --pass-env <name>              environment variable name to pass through; repeatable
  --workspace-seed <path>        directory copied into the clean Arena workspace
  --scenario <text>              UserCat low-information scenario opening
  --message <text>               UserCat message; repeatable
  --scenario-count <n>           UserCat scenario count
  --replay-attempts <n>          Reviewer replay attempts
  --max-replay-cases <n>         max Inspector cases selected for replay
  --timeout-ms <n>               sandbox command timeout
`);
}

function futureLiveRuntimeContract() {
  return {
    schema: "barena.xiaoba_live_runtime_contract.v1",
    xiaoba_version: "0.2.0",
    composite_call_contract: "barena.xiaoba_composite_calls.v1",
    provider_call_record_schema: "barena.provider_call.v1",
    bounds: {
      target_calls_per_turn: 1,
      usercat_calls_per_turn: 1,
      inspector_calls_per_attempt: 0,
      reviewer_calls_per_attempt: 0,
      replay_calls_per_case_turn: 1,
    },
    enforcement: {
      input_token_limit: true,
      output_token_limit: true,
      sdk_max_retries: 0,
      authoritative_per_call_telemetry: true,
      complete_provider_identity: true,
      complete_cost_basis: true,
    },
  };
}

function importSkill(skillValue) {
  const projectRoot = requireProjectRoot();
  const resolved = path.resolve(projectRoot, skillValue);
  const skillFile = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
    ? path.join(resolved, "SKILL.md")
    : resolved;
  if (!fs.existsSync(skillFile) || !fs.statSync(skillFile).isFile() || path.basename(skillFile) !== "SKILL.md") {
    throw new Error(`Skill path must point to SKILL.md or a skill directory: ${skillValue}`);
  }

  const text = fs.readFileSync(skillFile, "utf8");
  const name = frontmatterValue(text, "name") ?? path.basename(path.dirname(skillFile));
  const description = frontmatterValue(text, "description") ?? `Fake fixture Skill ${name}`;
  const fingerprint = fingerprintFiles([skillFile]);
  const subjectId = defaultId(["skill", name, skillFile]);
  const relativeSkillFile = relativeRef(projectRoot, skillFile);
  const manifest = {
    version: 1,
    subject_id: subjectId,
    subject: {
      type: "skill",
      name,
      description,
      capabilities: [description],
      required_tools: frontmatterList(text, "toolsets"),
    },
    source: { type: "local_skill", path: relativeSkillFile },
    parsed: {
      docs: [relativeSkillFile],
      prompt_files: [],
      skill_files: [relativeSkillFile],
      declared_tools: frontmatterList(text, "toolsets"),
    },
    safety: { risk_level: "low", warnings: [] },
    trust_level: "review_required",
    allowed_runtime: "arena_only",
    default_sandbox: {
      engine: "macos_seatbelt",
      mode: "read_only",
      network: "disabled",
      env_allowlist: [],
      timeout_ms: 180000,
    },
    fingerprint,
    created_at: nowIso(false),
  };
  writeJson(path.join(projectRoot, "arena", "subjects", subjectId, "arena-manifest.json"), manifest);
  return manifest;
}

function snapshotRole(roleId) {
  const projectRoot = requireProjectRoot();
  const roleRoot = path.join(process.env.XIAOBA_ROLES_ROOT || path.join(projectRoot, "roles"), safeSegment(roleId));
  const roleJsonPath = path.join(roleRoot, "role.json");
  if (!fs.existsSync(roleJsonPath)) throw new Error(`Role not found: ${roleId}`);
  const roleConfig = readJson(roleJsonPath);
  const files = listFiles(roleRoot);
  const fingerprint = fingerprintFiles(files);
  const name = String(roleConfig.name || roleId);
  const subjectId = defaultId(["role", name, fingerprint]);
  const docs = files.filter((file) => file.toLowerCase().endsWith(".md")).map((file) => relativeRef(projectRoot, file));
  const promptFiles = files.filter((file) => file.includes(`${path.sep}prompts${path.sep}`)).map((file) => relativeRef(projectRoot, file));
  const skillFiles = files.filter((file) => path.basename(file) === "SKILL.md");
  const localSkills = skillFiles.map((file) => frontmatterValue(fs.readFileSync(file, "utf8"), "name") ?? path.basename(path.dirname(file))).sort();
  const description = String(roleConfig.description || roleConfig.displayName || name);
  const declaredTools = unique([
    ...(Array.isArray(roleConfig.baseToolAllowlist) ? roleConfig.baseToolAllowlist : []),
    ...(Array.isArray(roleConfig.toolVisibility?.defaultTools) ? roleConfig.toolVisibility.defaultTools : []),
  ].map(String));
  const manifest = {
    version: 1,
    subject_id: subjectId,
    subject: {
      type: "role",
      name,
      description,
      capabilities: [description],
      required_tools: declaredTools,
    },
    source: { type: "local_role", path: relativeRef(projectRoot, roleRoot) },
    parsed: {
      docs,
      prompt_files: promptFiles,
      skill_files: skillFiles.map((file) => relativeRef(projectRoot, file)),
      declared_tools: declaredTools,
    },
    safety: { risk_level: "low", warnings: [] },
    trust_level: "review_required",
    allowed_runtime: "arena_only",
    default_sandbox: {
      engine: "macos_seatbelt",
      mode: "read_only",
      network: "disabled",
      env_allowlist: [],
      timeout_ms: 180000,
    },
    fingerprint,
    created_at: nowIso(false),
    role: {
      id: name,
      docs,
      local_skills: localSkills,
      declared_boundaries: [description],
      fingerprint,
    },
  };
  writeJson(path.join(projectRoot, "arena", "subjects", subjectId, "arena-manifest.json"), manifest);
  return manifest;
}

function executeArenaRun(flags) {
  const projectRoot = requireProjectRoot();
  const mode = requiredFlag(flags, "mode");
  if (!["base_skill", "role_skill", "role"].includes(mode)) throw new Error(`Unsupported review mode: ${mode}`);
  const subjectValue = requiredFlag(flags, "subject");
  const runId = safeSegment(requiredFlag(flags, "run-id"));
  const targetRole = stringFlag(flags, "target-role");
  if (["role_skill", "role"].includes(mode) && !targetRole) throw new Error(`${mode} requires targetRoleId`);
  const manifestPath = resolveManifest(projectRoot, subjectValue);
  const subject = readJson(manifestPath);
  if (["base_skill", "role_skill"].includes(mode) && subject.subject?.type !== "skill") {
    throw new Error(`${mode} requires subject.type=skill`);
  }
  if (mode === "role" && subject.subject?.type !== "role") throw new Error("role review mode requires subject.type=role");

  const prompt = [stringFlag(flags, "scenario") ?? "Fake XiaoBa native Arena task", ...arrayFlag(flags, "message")].join("\n");
  const requested = requestedBehavior(prompt);
  const callContext = providerCallContext(flags, runId, mode);
  const behavior = scopedBehavior(requested, callContext);
  const runRoot = path.join(projectRoot, "arena", "runs", runId);
  if (behavior === "collision") fail(`Arena run collision: ${runId}`, 73);
  fs.rmSync(runRoot, { recursive: true, force: true });

  const roots = {
    run_root: runRoot,
    home_root: path.join(runRoot, "home"),
    skills_root: path.join(runRoot, "skills"),
    roles_root: path.join(runRoot, "roles"),
    workspace_root: path.join(runRoot, "workspace"),
    tmp_root: path.join(runRoot, "tmp"),
  };
  for (const directory of [...Object.values(roots), path.join(runRoot, "debug")]) ensureDir(directory);
  if (behavior === "symlink_escape") {
    const escapedLogs = path.join(projectRoot, "..", `escaped-native-evidence-${safeSegment(runId)}`);
    ensureDir(escapedLogs);
    fs.symlinkSync(escapedLogs, path.join(roots.workspace_root, "logs"), "dir");
  }
  writeJson(path.join(roots.home_root, "skill-registry.json"), []);
  writeJson(path.join(roots.workspace_root, "skill-registry.json"), []);

  const workspaceSeed = stringFlag(flags, "workspace-seed");
  if (workspaceSeed) copyDirectory(path.resolve(projectRoot, workspaceSeed), roots.workspace_root);

  const subjectName = String(subject.subject.name);
  let stagedSkill;
  let stagedRole;
  let roleSource;
  if (["base_skill", "role_skill"].includes(mode)) {
    const skillSource = resolveSubjectSource(projectRoot, subject);
    stagedSkill = path.join(roots.skills_root, safeSegment(subjectName));
    copyDirectory(fs.statSync(skillSource).isDirectory() ? skillSource : path.dirname(skillSource), stagedSkill);
  }
  if (mode === "role") {
    roleSource = resolveSubjectSource(projectRoot, subject);
    stagedRole = path.join(roots.roles_root, safeSegment(targetRole));
    copyDirectory(roleSource, stagedRole);
  } else if (mode === "role_skill") {
    roleSource = path.join(process.env.XIAOBA_ROLES_ROOT || path.join(projectRoot, "roles"), safeSegment(targetRole));
    if (!fs.existsSync(roleSource)) throw new Error(`Role not found: ${targetRole}`);
    stagedRole = path.join(roots.roles_root, safeSegment(targetRole));
    copyDirectory(roleSource, stagedRole);
  }

  const activeRole = mode === "base_skill" ? "base" : String(targetRole);
  const roleLocalSkills = stagedRole ? discoverSkillNames(path.join(stagedRole, "skills")) : [];
  const loadedSkills = unique([...roleLocalSkills, ...(stagedSkill ? [subjectName] : [])]);
  const targetProfile = {
    active_role_id: activeRole,
    ...(stagedSkill && { subject_skill_id: subjectName }),
    loaded_skills: loadedSkills,
    role_local_skills: roleLocalSkills,
    registered_tools: ["read_file", "write_file", "skill"],
    provider_visible_tools: ["read_file", "write_file", "skill"],
    surface: stringFlag(flags, "surface") ?? "pet",
  };

  const stale = behavior === "stale";
  const contractRunId = stale ? `stale-${runId}` : runId;
  const timestamp = nowIso(stale);
  const sandboxEnforced = behavior !== "sandbox_not_enforced";
  const sandbox = {
    engine: "macos_seatbelt",
    mode: "workspace_write",
    workspace_root: roots.workspace_root,
    subject_root: stagedSkill ?? stagedRole ?? roots.workspace_root,
    writable_roots: [roots.home_root, roots.workspace_root, roots.tmp_root],
    network: "disabled",
    env_allowlist: [],
    timeout_ms: numberFlag(flags, "timeout-ms", 180000),
  };

  const cleanRuntimePath = path.join(runRoot, "clean-runtime.json");
  const runnerPath = path.join(runRoot, "arena-runner.json");
  writeJson(cleanRuntimePath, {
    version: 1,
    run_id: contractRunId,
    review_mode: mode,
    subject_id: subject.subject_id,
    subject_manifest_path: relativeRef(projectRoot, manifestPath),
    target_profile: targetProfile,
    roots,
    copied: {
      base_skills: [],
      missing_base_skills: [],
      ...(stagedSkill && { subject_skill: relativeRef(runRoot, stagedSkill) }),
      ...(stagedRole && { role: relativeRef(runRoot, stagedRole) }),
      ...(workspaceSeed && { workspace_seed: { source: workspaceSeed, file_count: listFiles(path.resolve(projectRoot, workspaceSeed)).length } }),
    },
    isolation: {
      production_skills_root: path.join(projectRoot, "skills"),
      production_roles_root: path.join(projectRoot, "roles"),
      registry_files: [path.join(roots.home_root, "skill-registry.json"), path.join(roots.workspace_root, "skill-registry.json")],
    },
    sandbox,
    launch: {
      cwd: roots.workspace_root,
      command: [process.execPath, path.join(projectRoot, "dist", "index.js"), ...(activeRole !== "base" ? ["--role", activeRole] : [])],
      env: {
        XIAOBA_ARENA: "1",
        XIAOBA_PROJECT_ROOT: projectRoot,
        XIAOBA_HOME: roots.home_root,
        XIAOBA_SKILLS_ROOT: roots.skills_root,
        XIAOBA_ROLES_ROOT: roots.roles_root,
        HOME: roots.home_root,
        TMPDIR: roots.tmp_root,
        NO_COLOR: "1",
      },
      pass_through_env: [],
      shell_command: "fake-xiaoba-native-worker",
      ...(sandboxEnforced && { sandbox_profile_path: path.join(runRoot, "sandbox", "profile.sb"), sandbox_shell_command: "fake-sandboxed-xiaoba-native-worker" }),
    },
    created_at: timestamp,
  });
  writeJson(runnerPath, {
    version: 1,
    run_id: contractRunId,
    command_kind: sandboxEnforced ? "sandbox_shell_command" : "shell_command",
    sandbox_enforced: sandboxEnforced,
    timeout_ms: sandbox.timeout_ms,
    worker_command: ["xiaoba", "arena", "run", "worker", "--run-id", runId],
    ...(sandboxEnforced ? { sandbox_shell_command: "fake-sandboxed-xiaoba-native-worker" } : { shell_command: "fake-xiaoba-native-worker" }),
    clean_runtime_path: cleanRuntimePath,
    created_at: timestamp,
  });

  const shouldCreateArtifact = shouldCreateResult({ prompt, mode, targetRole: activeRole, behavior });
  const artifactPath = path.join(roots.workspace_root, "result.txt");
  if (shouldCreateArtifact) {
    const artifact = `BARENA_XIAOBA_OK\nmode=${mode}\nrole=${activeRole}\nskill=${stagedSkill ? subjectName : "none"}\n`;
    if (behavior === "artifact_symlink_escape") {
      const escapedArtifact = path.join(projectRoot, "..", `escaped-artifact-${safeSegment(runId)}.txt`);
      fs.writeFileSync(escapedArtifact, artifact, "utf8");
      fs.symlinkSync(escapedArtifact, artifactPath);
    } else {
      fs.writeFileSync(artifactPath, artifact, "utf8");
    }
  }
  if (isDialogueGraphTask(prompt) && mode === "role_skill" && !["blocked", "unsafe"].includes(behavior)) {
    writeDialogueGraphArtifacts(roots.workspace_root);
  }

  const nativeTracePath = path.join(roots.workspace_root, "logs", "sessions", `fake-${safeSegment(runId)}`, "traces.jsonl");
  const nativeTraceRef = relativeRef(projectRoot, nativeTracePath);
  const debugRoot = path.join(runRoot, "debug");
  const usercatPackagePath = path.join(debugRoot, "usercat-1-package.json");
  const usercatControllerPath = path.join(debugRoot, "usercat-controller.jsonl");
  const inspectorAnalysisPath = path.join(debugRoot, "inspector-analysis.json");
  const inspectorCasesPath = path.join(debugRoot, "inspector-cases.json");
  const reviewerScorecardPath = path.join(debugRoot, "reviewer-scorecard.json");
  const reviewerReportPath = path.join(debugRoot, "reviewer-report.md");
  const providerCallRecordsPath = path.join(debugRoot, "provider-calls.ndjson");
  const providerCallRecordsRef = relativeRef(projectRoot, providerCallRecordsPath);
  const providerCallRecords = buildProviderCallRecords({
    behavior,
    callContext,
    maxTurns: numberFlag(flags, "max-turns", 4),
    provider: process.env.XIAOBA_LLM_PROVIDER || "fake-provider",
    model: process.env.XIAOBA_LLM_MODEL || "fake-model",
    outputLimit: positiveEnvironmentInteger("XIAOBA_LLM_MAX_TOKENS", 100),
    inputPrice: nonNegativeEnvironmentNumber("XIAOBA_LLM_INPUT_USD_PER_MILLION_TOKENS", 1),
    outputPrice: nonNegativeEnvironmentNumber("XIAOBA_LLM_OUTPUT_USD_PER_MILLION_TOKENS", 2),
    evidenceRefs: {
      target: nativeTraceRef,
      usercat: relativeRef(projectRoot, usercatPackagePath),
      inspector: relativeRef(projectRoot, inspectorAnalysisPath),
      reviewer: relativeRef(projectRoot, reviewerScorecardPath),
      replay: relativeRef(projectRoot, reviewerScorecardPath),
    },
  });
  ensureDir(path.dirname(providerCallRecordsPath));
  fs.writeFileSync(providerCallRecordsPath, `${providerCallRecords.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

  if (behavior !== "missing_trace") {
    ensureDir(path.dirname(nativeTracePath));
    if (behavior === "invalid_trace") {
      fs.writeFileSync(nativeTracePath, "{not-valid-json\n", "utf8");
    } else {
      const traceEntry = {
        schema_version: 3,
        entry_type: "trace",
        trace_id: `${contractRunId}.trace.1`,
        trace_index: 1,
        episode_id: `${contractRunId}.trace.1`,
        episode_index: 1,
        turn_id: `${contractRunId}.turn.1`,
        turn: 1,
        timestamp,
        session_id: `fake-${contractRunId}`,
        session_type: "arena",
        user: { text: prompt },
        assistant: {
          text: shouldCreateArtifact ? "Created the requested artifact." : "Completed without the candidate capability artifact.",
          tool_calls: shouldCreateArtifact ? [{
            tool_call_id: `${contractRunId}.tool.1`,
            name: "write_file",
            arguments: { path: "result.txt" },
            result: "written",
            status: "success",
            artifact_manifest: [{ path: artifactPath, type: "text", action: "created" }],
          }] : [],
        },
        ...providerIdentityFields(
          behavior,
          process.env.XIAOBA_LLM_PROVIDER || "fake-provider",
          process.env.XIAOBA_LLM_MODEL || "fake-model"
        ),
        tokens: { prompt: 1, completion: 1 },
        tool_visibility: [{
          roleName: activeRole,
          ...(stagedSkill && { activeSkillName: subjectName }),
          mode: stagedSkill ? "skill_scoped" : "all",
          visibleTools: targetProfile.provider_visible_tools,
          hiddenToolCount: stagedSkill ? 1 : 0,
          gatedToolCount: 0,
        }],
        events: [{ type: "fake_xiaoba_native_execution", review_mode: mode, sandbox_enforced: sandboxEnforced }],
      };
      fs.writeFileSync(nativeTracePath, `${JSON.stringify(traceEntry)}\n`, "utf8");
    }
  }

  writeJson(usercatPackagePath, { version: 1, run_id: `${contractRunId}-usercat-1`, status: behavior === "blocked" ? "blocked" : "pass", trace_path: nativeTraceRef });
  fs.writeFileSync(usercatControllerPath, `${JSON.stringify({ type: "usercat_controller", run_id: contractRunId, trace_ref: nativeTraceRef })}\n`, "utf8");
  writeJson(inspectorAnalysisPath, { version: 1, run_id: contractRunId, trace_refs: [nativeTraceRef], status: behavior === "blocked" ? "blocked" : "pass" });
  writeJson(inspectorCasesPath, { version: 1, run_id: contractRunId, inspector_role: "inspector-cat", trace_refs: [nativeTraceRef], cases: behavior === "unsafe" ? [{ case_id: `${contractRunId}.unsafe`, issue_type: "unsafe_action", severity: "high", evidence_refs: [nativeTraceRef] }] : [] });

  const decision = behavior === "unsafe" ? "unsafe" : behavior === "blocked" ? "blocked" : behavior === "unstable" ? "unstable" : "pass";
  const stages = behavior === "blocked"
    ? { usercat: { status: "blocked" }, inspector: { status: "blocked" }, reviewer: { status: "blocked" } }
    : { usercat: { status: "pass" }, inspector: { status: "pass" }, reviewer: { status: behavior === "unstable" ? "fail" : "pass" } };
  const replayAttempts = behavior === "unstable"
    ? { planned: 2, completed: 2, pass_count: 1, fail_count: 1, blocked_count: 0, trace_refs: [nativeTraceRef] }
    : behavior === "blocked"
      ? { planned: 1, completed: 1, pass_count: 0, fail_count: 0, blocked_count: 1, trace_refs: [] }
      : behavior === "unsafe"
        ? { planned: 0, completed: 0, pass_count: 0, fail_count: 0, blocked_count: 0, trace_refs: [] }
        : { planned: 1, completed: 1, pass_count: 1, fail_count: 0, blocked_count: 0, trace_refs: [nativeTraceRef] };
  const scorecardPath = path.join(runRoot, "arena-scorecard.json");
  const arenaRunPath = path.join(runRoot, "arena-run.json");
  const scorecard = {
    version: 1,
    scorecard_type: "arena",
    run_id: `${contractRunId}-reviewer`,
    arena_run_id: contractRunId,
    generated_at: timestamp,
    decision,
    review_mode: mode,
    subject_id: subject.subject_id,
    target_profile: targetProfile,
    stages,
    cases: [],
    replay_attempts: replayAttempts,
    arena_eval_profile: {
      profile: "normal",
      scenario_count: numberFlag(flags, "scenario-count", 1),
      max_usercat_turns: 1,
      replay_attempts_per_case: numberFlag(flags, "replay-attempts", 1),
      replay_case_count: 0,
      inspector_case_count: behavior === "unsafe" ? 1 : 0,
      max_replay_cases: numberFlag(flags, "max-replay-cases", 1),
      planned_replay_attempts: replayAttempts.planned,
    },
    usercat_runs: [{
      index: 1,
      status: behavior === "blocked" ? "blocked" : "pass",
      run_id: `${contractRunId}-usercat-1`,
      scenario: prompt,
      package_path: relativeRef(projectRoot, usercatPackagePath),
      trace_path: nativeTraceRef,
    }],
    replay_results: [],
    evidence: {
      trace_refs: [nativeTraceRef],
      replay_trace_refs: replayAttempts.trace_refs,
      debug_dir: relativeRef(projectRoot, debugRoot),
      arena_scorecard: relativeRef(projectRoot, scorecardPath),
      arena_run: relativeRef(projectRoot, arenaRunPath),
    },
    debug_refs: {
      usercat_package: relativeRef(projectRoot, usercatPackagePath),
      usercat_packages: [relativeRef(projectRoot, usercatPackagePath)],
      usercat_controller_trace: relativeRef(projectRoot, usercatControllerPath),
      usercat_controller_traces: [relativeRef(projectRoot, usercatControllerPath)],
      inspector_analysis: relativeRef(projectRoot, inspectorAnalysisPath),
      inspector_cases: relativeRef(projectRoot, inspectorCasesPath),
      reviewer_scorecard: relativeRef(projectRoot, reviewerScorecardPath),
      reviewer_report: relativeRef(projectRoot, reviewerReportPath),
      provider_calls: providerCallRecordsRef,
      replay_result_refs: [],
    },
    sandbox: { ...sandbox, enforced: sandboxEnforced },
    summary: `Fake XiaoBa Arena ${decision} for ${mode}.`,
  };
  writeJson(reviewerScorecardPath, { ...scorecard, scorecard_type: "arena_reviewer" });
  fs.writeFileSync(reviewerReportPath, `# Fake XiaoBa Reviewer\n\nDecision: ${decision}\n`, "utf8");
  writeJson(arenaRunPath, {
    version: 1,
    run_id: contractRunId,
    review_mode: mode,
    subject_id: subject.subject_id,
    subject_manifest_path: relativeRef(projectRoot, manifestPath),
    target_profile: targetProfile,
    usercat_run_ref: {
      run_id: `${contractRunId}-usercat-1`,
      package_path: relativeRef(projectRoot, usercatPackagePath),
      trace_refs: [nativeTraceRef],
    },
    trace_refs: [nativeTraceRef],
    inspector_refs: [relativeRef(projectRoot, inspectorCasesPath)],
    reviewer_ref: {
      run_id: `${contractRunId}-reviewer`,
      scorecard_path: relativeRef(projectRoot, reviewerScorecardPath),
      report_path: relativeRef(projectRoot, reviewerReportPath),
    },
    replay_attempts: replayAttempts,
    sandbox,
    decision,
    scorecard_summary: scorecard.summary,
    promotion: {},
    created_at: timestamp,
  });
  writeJson(scorecardPath, scorecard);
  fs.writeFileSync(path.join(runRoot, "arena-runner.stdout.log"), "fake XiaoBa native Arena completed\n", "utf8");
  fs.writeFileSync(path.join(runRoot, "arena-runner.stderr.log"), "", "utf8");
  return scorecard;
}

function shouldCreateResult({ prompt, mode, targetRole, behavior }) {
  if (["blocked", "unsafe"].includes(behavior)) return false;
  if (prompt.includes("FAKE_REQUIRE_SKILL")) return mode === "base_skill" || mode === "role_skill";
  const requiredRole = prompt.match(/FAKE_REQUIRE_ROLE[:=]([a-zA-Z0-9._-]+)/)?.[1];
  if (requiredRole) return mode === "role" && targetRole === requiredRole;
  return true;
}

function isDialogueGraphTask(prompt) {
  return prompt.includes("script.txt") && (
    (prompt.includes("Convert the branching narrative") && prompt.includes("dialogue.json")) ||
    prompt.includes("something my game can load")
  );
}

function writeDialogueGraphArtifacts(workspaceRoot) {
  const scriptPath = path.join(workspaceRoot, "script.txt");
  const text = fs.readFileSync(scriptPath, "utf8");
  const headers = [...text.matchAll(/^\[([^\]]+)\]\s*$/gm)];
  const nodes = [];
  const edges = [];
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    const id = header[1].trim();
    const bodyStart = (header.index ?? 0) + header[0].length;
    const bodyEnd = headers[index + 1]?.index ?? text.length;
    const lines = text.slice(bodyStart, bodyEnd).split("\n").map((line) => line.trim()).filter(Boolean);
    const choiceLines = lines.filter((line) => /^\d+\.\s+/.test(line));
    if (choiceLines.length) {
      nodes.push({ id, text: "", speaker: "", type: "choice" });
      for (const line of choiceLines) {
        const match = line.match(/^\d+\.\s+(.*?)\s+->\s+([A-Za-z0-9._-]+)$/);
        if (!match) throw new Error(`Cannot parse fake dialogue choice: ${line}`);
        edges.push({ from: id, to: match[2], text: match[1] });
      }
      continue;
    }
    const match = lines[0]?.match(/^([^:]+):\s+(.*?)\s+->\s+([A-Za-z0-9._-]+)$/);
    if (!match) throw new Error(`Cannot parse fake dialogue line in ${id}`);
    nodes.push({ id, text: match[2], speaker: match[1], type: "line" });
    edges.push({ from: id, to: match[3], text: "" });
  }
  writeJson(path.join(workspaceRoot, "dialogue.json"), { nodes, edges });
}

function requestedBehavior(prompt) {
  const explicit = String(process.env.FAKE_XIAOBA_BEHAVIOR || "").trim().toLowerCase();
  const supported = new Set(["invalid_trace", "missing_trace", "unsafe", "blocked", "unstable", "sandbox_not_enforced", "stale", "collision"]);
  for (const behavior of [
    "missing_identity",
    "mismatched_identity",
    "retries",
    "missing_evaluator_telemetry",
    "duplicate_calls",
    "per_call_token_overrun",
    "reservation_overrun",
    "post_call_failure",
    "selected_unsafe",
    "selected_blocked",
  ]) supported.add(behavior);
  const aliases = new Map([
    ["missing_provider_identity", "missing_identity"],
    ["mismatched_provider_identity", "mismatched_identity"],
    ["provider_identity_mismatch", "mismatched_identity"],
  ]);
  if (aliases.has(explicit)) return aliases.get(explicit);
  if (supported.has(explicit)) return explicit;
  const markers = [
    ["FAKE_INVALID_TRACE", "invalid_trace"],
    ["FAKE_MISSING_TRACE", "missing_trace"],
    ["FAKE_MISSING_IDENTITY", "missing_identity"],
    ["FAKE_MISMATCHED_IDENTITY", "mismatched_identity"],
    ["FAKE_RETRIES", "retries"],
    ["FAKE_MISSING_EVALUATOR_TELEMETRY", "missing_evaluator_telemetry"],
    ["FAKE_DUPLICATE_CALLS", "duplicate_calls"],
    ["FAKE_PER_CALL_TOKEN_OVERRUN", "per_call_token_overrun"],
    ["FAKE_RESERVATION_OVERRUN", "reservation_overrun"],
    ["FAKE_SELECTED_UNSAFE", "selected_unsafe"],
    ["FAKE_SELECTED_BLOCKED", "selected_blocked"],
    ["FAKE_UNSAFE", "unsafe"],
    ["FAKE_BLOCKED", "blocked"],
    ["FAKE_UNSTABLE", "unstable"],
    ["FAKE_SANDBOX_NOT_ENFORCED", "sandbox_not_enforced"],
    ["FAKE_STALE_RUN", "stale"],
    ["FAKE_RUN_COLLISION", "collision"],
  ];
  return markers.find(([marker]) => prompt.includes(marker))?.[1] ?? "pass";
}

function scopedBehavior(behavior, callContext) {
  const outcome = behavior === "selected_unsafe"
    ? "unsafe"
    : behavior === "selected_blocked"
      ? "blocked"
      : behavior;
  if (!["unsafe", "blocked"].includes(outcome)) return behavior;

  const selectedMode = behavior.startsWith("selected_");
  const prefix = outcome === "unsafe" ? "FAKE_XIAOBA_UNSAFE" : "FAKE_XIAOBA_BLOCKED";
  const selectedArmValue = String(
    process.env[`${prefix}_ARM`] || process.env.FAKE_XIAOBA_SELECTED_ARM || (selectedMode ? "candidate" : "")
  ).trim().toLowerCase();
  const selectedAttemptValue = String(
    process.env[`${prefix}_ATTEMPT`] || process.env.FAKE_XIAOBA_SELECTED_ATTEMPT || (selectedMode ? "1" : "")
  ).trim();
  const selectedArm = ["baseline", "candidate"].includes(selectedArmValue) ? selectedArmValue : undefined;
  const selectedAttempt = /^[1-9]\d*$/.test(selectedAttemptValue) ? Number(selectedAttemptValue) : undefined;
  if (selectedArm && callContext.arm !== selectedArm) return "pass";
  if (selectedAttempt && callContext.attempt !== selectedAttempt) return "pass";
  return outcome;
}

function providerCallContext(flags, runId, mode) {
  const inferred = runId.match(/(?:^|.*-)(baseline|candidate)-(.+)-([1-9]\d*)-[^-]+$/);
  const explicitArm = stringFlag(flags, "barena-arm") || stringFlag(flags, "arm");
  const arm = ["baseline", "candidate"].includes(String(explicitArm))
    ? String(explicitArm)
    : inferred?.[1] || (mode === "role_skill" ? "candidate" : "baseline");
  const caseId = stringFlag(flags, "barena-case-id") || stringFlag(flags, "case-id") || inferred?.[2] || "fixture-case";
  const explicitAttempt = Number(stringFlag(flags, "barena-attempt") || stringFlag(flags, "attempt"));
  const attempt = Number.isInteger(explicitAttempt) && explicitAttempt > 0
    ? explicitAttempt
    : Number(inferred?.[3] || 1);
  return { runId, arm, caseId, attempt };
}

function buildProviderCallRecords({
  behavior,
  callContext,
  maxTurns,
  provider,
  model,
  outputLimit,
  inputPrice,
  outputPrice,
  evidenceRefs,
}) {
  const components = behavior === "missing_evaluator_telemetry"
    ? ["target"]
    : ["target", ...(maxTurns > 1 ? ["usercat"] : []), "replay"];
  const records = components.map((component, index) => {
    const inputTokens = index + 1;
    const outputTokens = behavior === "per_call_token_overrun" && component === "target"
      ? outputLimit + 1
      : 1;
    return {
      schema: "barena.provider_call.v1",
      call_id: `${callContext.runId}.provider-call.${String(index + 1).padStart(2, "0")}.${component}`,
      arm: callContext.arm,
      case_id: callContext.caseId,
      attempt: callContext.attempt,
      component,
      ...providerIdentityFields(behavior, provider, model),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      requested_output_limit: outputLimit,
      configured_max_retries: behavior === "retries" ? 1 : 0,
      observed_retries: behavior === "retries" ? 1 : 0,
      estimated_cost_usd: roundNumber((inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000),
      billed_cost_usd: null,
      evidence_ref: evidenceRefs[component],
    };
  });
  if (behavior === "duplicate_calls" && records.length > 0) {
    records.push({ ...records[0] });
  }
  if (behavior === "reservation_overrun") {
    const inputTokens = 1;
    const outputTokens = 1;
    records.push({
      schema: "barena.provider_call.v1",
      call_id: `${callContext.runId}.provider-call.04.target-reservation-overrun`,
      arm: callContext.arm,
      case_id: callContext.caseId,
      attempt: callContext.attempt,
      component: "target",
      ...providerIdentityFields(behavior, provider, model),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      requested_output_limit: outputLimit,
      configured_max_retries: 0,
      observed_retries: 0,
      estimated_cost_usd: roundNumber((inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000),
      billed_cost_usd: null,
      evidence_ref: evidenceRefs.target,
    });
  }
  return records;
}

function providerIdentityFields(behavior, provider, model) {
  if (behavior === "missing_identity") return {};
  if (behavior === "mismatched_identity") {
    return { provider: `${provider}-mismatch`, model: `${model}-mismatch` };
  }
  return { provider, model };
}

function positiveEnvironmentInteger(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeEnvironmentNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function roundNumber(value) {
  return Number(value.toFixed(12));
}

function requireProjectRoot() {
  const value = String(process.env.XIAOBA_PROJECT_ROOT || "").trim();
  if (!value) throw new Error("XIAOBA_PROJECT_ROOT is required by the fake XiaoBa native CLI");
  const root = path.resolve(value);
  ensureDir(root);
  return root;
}

function resolveManifest(projectRoot, value) {
  const candidate = value.endsWith("arena-manifest.json")
    ? path.resolve(projectRoot, value)
    : path.join(projectRoot, "arena", "subjects", safeSegment(value), "arena-manifest.json");
  if (!fs.existsSync(candidate)) throw new Error(`Arena subject not found: ${value}`);
  return candidate;
}

function resolveSubjectSource(projectRoot, manifest) {
  const source = path.resolve(projectRoot, String(manifest.source?.path || ""));
  if (!fs.existsSync(source)) throw new Error(`Subject source not found: ${manifest.subject_id}`);
  return source;
}

function parseFlags(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith("--")) continue;
    const name = item.slice(2);
    const next = values[index + 1];
    const value = !next || next.startsWith("--") ? true : next;
    if (value !== true) index += 1;
    const previous = result.get(name);
    result.set(name, previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value]);
  }
  return result;
}

function requiredFlag(flags, name) {
  const value = stringFlag(flags, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function stringFlag(flags, name) {
  const value = flags.get(name);
  if (Array.isArray(value)) return String(value[value.length - 1]);
  return typeof value === "string" ? value : undefined;
}

function arrayFlag(flags, name) {
  const value = flags.get(name);
  if (Array.isArray(value)) return value.map(String);
  return typeof value === "string" ? [value] : [];
}

function numberFlag(flags, name, fallback) {
  const value = Number(stringFlag(flags, name));
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function requiredPositional(values, index, label) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${label} is required`);
  return value;
}

function matches(values, prefix) {
  return prefix.every((value, index) => values[index] === value);
}

function frontmatterValue(text, key) {
  const frontmatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!frontmatter) return undefined;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return frontmatter.match(new RegExp(`^${escaped}:\\s*[\"']?([^\\r\\n\"']+)[\"']?\\s*$`, "m"))?.[1]?.trim();
}

function frontmatterList(text, key) {
  const value = frontmatterValue(text, key);
  if (!value) return [];
  return value.replace(/^\[|\]$/g, "").split(",").map((item) => item.trim().replace(/^[\"']|[\"']$/g, "")).filter(Boolean);
}

function discoverSkillNames(root) {
  if (!fs.existsSync(root)) return [];
  return listFiles(root)
    .filter((file) => path.basename(file) === "SKILL.md")
    .map((file) => frontmatterValue(fs.readFileSync(file, "utf8"), "name") ?? path.basename(path.dirname(file)))
    .sort();
}

function fingerprintFiles(files) {
  const hash = crypto.createHash("sha256");
  for (const file of [...files].sort()) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    hash.update(path.basename(file));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function defaultId(parts) {
  const readable = safeSegment(parts.find((part) => part && !part.includes("/")) || "arena");
  const hash = crypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 10);
  return `${readable}-${hash}`;
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files.sort();
}

function copyDirectory(source, destination) {
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error(`Directory does not exist: ${source}`);
  ensureDir(destination);
  fs.cpSync(source, destination, { recursive: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function relativeRef(root, file) {
  return path.relative(root, path.resolve(file)).split(path.sep).join("/");
}

function safeSegment(value) {
  return String(value).trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "arena-item";
}

function unique(values) {
  return [...new Set(values)];
}

function nowIso(stale) {
  return stale ? "2000-01-01T00:00:00.000Z" : new Date().toISOString();
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message, code) {
  process.stderr.write(`fake-xiaoba-native: ${message}\n`);
  process.exit(code);
}
