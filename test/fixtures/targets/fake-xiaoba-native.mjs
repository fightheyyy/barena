#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);

try {
  if (argv.length === 1 && argv[0] === "--version") {
    process.stdout.write("0.1.1\n");
  } else if (matches(argv, ["arena", "import", "skill"]) && argv.includes("--help")) {
    process.stdout.write("Usage: xiaoba arena import skill <path>\n");
  } else if (matches(argv, ["arena", "snapshot", "role"]) && argv.includes("--help")) {
    process.stdout.write("Usage: xiaoba arena snapshot role <role-id>\n");
  } else if (matches(argv, ["arena", "runtime", "prepare"]) && argv.includes("--help")) {
    process.stdout.write("Usage: xiaoba arena runtime prepare --mode base_skill|role_skill|role\n");
  } else if (matches(argv, ["arena", "run", "execute"]) && argv.includes("--help")) {
    printExecuteHelp();
  } else if (argv.length === 2 && matches(argv, ["arena"]) && argv.includes("--help")) {
    process.stdout.write("Arena commands: skill import snapshot run runtime\n");
  } else if (matches(argv, ["arena", "import", "skill"])) {
    printJson(importSkill(requiredPositional(argv, 3, "skill path")));
  } else if (matches(argv, ["arena", "snapshot", "role"])) {
    printJson(snapshotRole(requiredPositional(argv, 3, "role id")));
  } else if (matches(argv, ["arena", "run", "execute"])) {
    printJson(executeArenaRun(parseFlags(argv.slice(3))));
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
  const behavior = requestedBehavior(prompt);
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
    fs.writeFileSync(artifactPath, `BARENA_XIAOBA_OK\nmode=${mode}\nrole=${activeRole}\nskill=${stagedSkill ? subjectName : "none"}\n`, "utf8");
  }

  const nativeTracePath = path.join(roots.workspace_root, "logs", "sessions", `fake-${safeSegment(runId)}`, "traces.jsonl");
  const nativeTraceRef = relativeRef(projectRoot, nativeTracePath);
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

  const debugRoot = path.join(runRoot, "debug");
  const usercatPackagePath = path.join(debugRoot, "usercat-1-package.json");
  const usercatControllerPath = path.join(debugRoot, "usercat-controller.jsonl");
  const inspectorAnalysisPath = path.join(debugRoot, "inspector-analysis.json");
  const inspectorCasesPath = path.join(debugRoot, "inspector-cases.json");
  const reviewerScorecardPath = path.join(debugRoot, "reviewer-scorecard.json");
  const reviewerReportPath = path.join(debugRoot, "reviewer-report.md");
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

function requestedBehavior(prompt) {
  const explicit = String(process.env.FAKE_XIAOBA_BEHAVIOR || "").trim().toLowerCase();
  const supported = new Set(["invalid_trace", "missing_trace", "unsafe", "blocked", "unstable", "sandbox_not_enforced", "stale", "collision"]);
  if (supported.has(explicit)) return explicit;
  const markers = [
    ["FAKE_INVALID_TRACE", "invalid_trace"],
    ["FAKE_MISSING_TRACE", "missing_trace"],
    ["FAKE_UNSAFE", "unsafe"],
    ["FAKE_BLOCKED", "blocked"],
    ["FAKE_UNSTABLE", "unstable"],
    ["FAKE_SANDBOX_NOT_ENFORCED", "sandbox_not_enforced"],
    ["FAKE_STALE_RUN", "stale"],
    ["FAKE_RUN_COLLISION", "collision"],
  ];
  return markers.find(([marker]) => prompt.includes(marker))?.[1] ?? "pass";
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
