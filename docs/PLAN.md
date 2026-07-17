# Barena PLAN

## Current Status

The product category remains frozen in [`docs/POSITIONING.md`](POSITIONING.md): Agent E2E release CI. Version 1.1 records an evidence-driven tactical amendment: XiaoBa-CLI is the first native target for Role and Skill release evaluation, while OpenClaw remains the first external `TargetAdapter`. XiaoBa native Arena suites/cases are the first executable case source; SkillsBench remains the next external calibration source, not the product category.

Barena now has a first-party XiaoBa 0.1.1 native Role/Skill release path plus the existing paired OpenClaw Skill path. The native path probes the exact CLI, stages immutable Role/Skill inputs, gives every Barena attempt a fresh XiaoBa project root/run ID/workspace, executes `role` or `role_skill`, validates filesystem-authoritative Arena outputs, proves candidate Skill activation from session-log-v3 traces, runs Barena artifact assertions, copies and hashes evidence, and aggregates truth/lift/stability/quality into `cleared`, `held`, or `rejected`.

The canonical core evaluation DAG is now visible in the README, repository SPEC, and interactive TUI. It separates XiaoBa's native `UserCat → target → Trace → InspectorCat → ReviewerCat` lane from Barena's artifact-verifier lane, then joins both in the evidence package before paired aggregation and the final Barena release gate.

The native and external paths remain distinct. XiaoBa native evaluation is the first real target-runtime vertical slice and does not pass through `TargetAdapter`. It is not a three-evaluator-AgentSession path: XiaoBa 0.1.1 uses XiaoBa-owned UserCat/Inspector/Reviewer pipeline stages and only the target emits native AgentSession traces. Results record both `three_evaluator_agent_sessions=false` and the weaker isolation facts. OpenClaw continues to produce an honest structured `blocked` result until the external target-driver seam exists. Neither path substitutes the legacy deterministic TypeScript Cats.

## Milestones

- [x] Define repository architecture and SuperDev docs.
- [x] Create TypeScript CLI scaffold.
- [x] Implement local skill subject import.
- [x] Implement clean run directory creation.
- [x] Implement UserCat, InspectorCat, ReviewerCat MVP contracts.
- [x] Implement deterministic XiaoBa adapter boundary for scaffold verification.
- [x] Add neutral runtime contracts inspired by XiaoBa without importing XiaoBa source.
- [x] Add evidence-first scorecard fields for stages, replay attempts, artifacts, and debug refs.
- [x] Add tests for cleared and unsafe decisions.
- [x] Add GitHub import command path.
- [x] Add scan, replay, verifier, report, list, doctor CLI surfaces.
- [x] Add package `files`, `main`, `types`, `exports`, and `prepack`.
- [x] Document honest XiaoBa-compatible adapter stance.
- [x] Add XiaoBa-style black/gold `ANSI Shadow` TUI masthead.
- [x] Add a canonical Barena core evaluation DAG to README, SPEC, and the responsive interactive TUI.
- [x] Document Barena as an agent-facing clearance skill.
- [ ] Replace deterministic adapter internals with real XiaoBa AgentSession bridge.
- [x] Add native `role + skill` evaluation support through XiaoBa `role_skill`.
- [ ] Create installable `barena-clearance` skill.
- [x] Add static scan policy for external GitHub skills.
- [x] Add built-in agent CI targets for opencode, XiaoBa, Hermes Agent, and OpenClaw.
- [x] Reposition public documentation around Agent E2E testing while preserving an honest deterministic MVP boundary.
- [x] Separate the fixed XiaoBa evaluator runtime from pluggable target-agent adapters in the architecture.
- [x] Lock the product positioning, Phase 1 Skill-change wedge, non-goals, public language, and change-control rules.
- [x] Define and implement `barena.agent_e2e_case.v1` for task, fixture, artifact assertion, replay, timeout, and isolation policy.
- [x] Implement provenance-aware Barena boundary traces with optional native trace references.
- [x] Implement XiaoBa evaluator-runtime preflight and fail closed when external-agent mode is unavailable.
- [x] Implement the local-only OpenClaw JSON CLI `TargetAdapter` with strict protocol parsing.
- [x] Add `barena e2e probe` and `barena e2e run <case.json>`.
- [x] Add artifact assertion, replay, evidence coverage, and confidence to Agent E2E scorecards.
- [x] Add focused fake-binary tests for subprocess interaction, protocol failure, blocked behavior, replay isolation, and evidence provenance.
- [x] Add the paired Skill evaluation request/result contract and deterministic baseline/candidate aggregation.
- [x] Bind isolated OpenClaw baseline/candidate workspaces with explicit Skill allowlists and eligibility preflight.
- [x] Make zero-argument interactive `barena` open the Skill release evaluation TUI while preserving non-TTY help behavior.
- [x] Add result, blocked-state, and persisted boundary-trace views to the TUI.
- [x] Add the automation-equivalent `barena evaluate skill` command.
- [x] Amend the locked positioning contract with evidence for XiaoBa as the first native target and OpenClaw as the first external target.
- [x] Define the native/external dual-path target architecture with logically separate XiaoBa evaluator and target planes.
- [x] Confirm and pin the exact XiaoBa native CLI, subject, suite, output, trace, and isolation contract.
- [x] Add generalized Role/Skill paired evaluation contracts without breaking `barena.skill_evaluation.v1` reads.
- [x] Implement XiaoBa native Arena probe/execution, evidence copy/hash, normalization, and honest blocked reasons.
- [x] Implement same-Role Skill comparison and explicit baseline-Role comparison.
- [x] Add XiaoBa/Skill/Role choices and truthful baseline inputs to the zero-argument TUI and automation CLI.
- [x] Add fake XiaoBa contract tests plus a real no-secret local smoke and trace/result rendering verification.
- [ ] Add the narrow external-target Arena seam upstream in XiaoBa-CLI so all three evaluator roles use real AgentSessions.
- [ ] Add cross-version regression comparison and flake reporting.

## Next Steps

1. Publish the first transparent, model-backed XiaoBa Role/Skill calibration report using the implemented native evidence package.
2. Add the XiaoBa external-agent seam, then run OpenClaw/SkillsBench calibration.
3. Put the same persisted release decision into GitHub CI.
4. Add cross-version comparison and flake reporting without weakening the paired case contract.

## Owners

- Parent Codex agent owns architecture, integration, and final verification.
- `/root/barena_xiaoba_architecture`: completed both its read-only architecture Goal and bounded fake-XiaoBa fixture Goal; parent reviewed and corrected the fixture help/Role-root behavior against the production runner.
- `/root/xiaoba_native_contract`: completed both its read-only contract Goal and bounded native core implementation Goal; parent reviewed the code, corrected Arena `arena_run_id` handling and relative manifest resolution, then exercised both paired paths.
- Independent verification child dispatch was attempted twice but rejected by the agent thread limit; parent records this as a lower-confidence sequential verification fallback and owns the complete test matrix.
- Barena contracts remain independent from XiaoBa and OpenClaw source trees; integration occurs through CLIs and explicit manifests.

## Acceptance Criteria

- `npm run build` succeeds.
- `npm test` succeeds.
- `npm run pack:dry-run` succeeds and package contents are limited by `files`.
- A fixture skill can be imported and run to a `cleared` scorecard.
- Built-in agent targets can be listed, imported as `agent` subjects, and run to scorecards with target metadata.
- An unsafe fixture skill is rejected with `unsafe`.
- A missing-artifact fixture is held.
- A verifier failure holds the subject.
- CLI smoke passes for help, doctor, import, scan, run, report, scorecard, and TUI snapshot.
- README and package metadata lead with Agent E2E testing, identify XiaoBa native Role/Skill evaluation as implemented, and label only the external cross-runtime evaluator seam as coming soon.
- No Dashboard, Electron, Pet, Feishu, Weixin, `node_modules`, logs, output, or secrets are copied into Barena.
- `TargetAdapter` executes an injected fake OpenClaw process with `shell: false`, preserves multi-line prompt bytes through a message file, and strictly parses the complete JSON stdout envelope.
- The OpenClaw adapter emits Barena-owned boundary evidence for input, stdout/stderr, process status, and workspace artifacts without fabricating target-native tool calls.
- Every replay gets a unique target session and isolated state paths.
- A missing OpenClaw binary/config or incompatible CLI yields a structured `blocked` target result.
- Missing XiaoBa external-agent mode yields `xiaoba_external_agent_mode_unavailable`, with all evaluator stages blocked and no deterministic fallback.
- Agent E2E scorecards distinguish target completion from verifier success and record evidence coverage/confidence.
- Interactive `barena` can select a local Skill, OpenClaw, case, and total attempts; it never labels an unproven Skill injection as evaluated.
- The paired Skill result reports verifier-backed truth, observed Skill lift, stability/quality, evidence coverage, and a deterministic release reason.
- TUI trace views render persisted NDJSON provenance and display an explicit no-trace message when preflight blocks target execution.
- Non-interactive `barena evaluate skill` produces the same persisted evaluation artifact as the TUI.
- Existing deterministic clearance tests remain green.
- XiaoBa native Skill evaluation compares the same explicit Role without and with the candidate Skill, or returns a structured baseline blocker.
- XiaoBa native Role evaluation requires an explicit baseline Role and pins common suite/model/tool conditions.
- XiaoBa native attempts preserve original Arena scorecard/native traces/evaluator refs and copy/hash them into the Barena run package.
- XiaoBa native results explicitly record `three_evaluator_agent_sessions=false`, `evaluator_target_process_isolated=false`, and `network_disabled_is_hard_boundary=false`; UI/docs never overstate the current isolation or call the stages three independent evaluator AgentSessions.
- The TUI and automation CLI can select XiaoBa plus Skill or Role and expose the same persisted paired result.
- README and TUI expose the same core DAG, distinguish the native Reviewer score from the Barena verifier and final gate, and remain readable at 40, 80, and 120 terminal columns.
- XiaoBa and OpenClaw paths coexist; existing OpenClaw contract tests remain green.

## Verification Log

- 2026-07-03: `npm run check` passed after initial scaffold.
- 2026-07-03: CLI smoke passed for `import skill`, `run`, and `scorecard` using `test/fixtures/skills/good-skill`.
- 2026-07-03: MVP1 typecheck and tests passed after scan/replay/verifier/report implementation.
- 2026-07-03: CLI smoke passed for help, doctor, import, scan, run with replay/verifier, and Markdown report using temporary subjects/runs roots.
- 2026-07-03: `npm run check` passed with 4 tests.
- 2026-07-03: `npm run pack:dry-run` passed; package contents are limited by `files`.
- 2026-07-03: Final CLI smoke passed for import, scan, run with 2 replays + verifier, scorecard readback, and Markdown report.
- 2026-07-03: TUI MVP landed with XiaoBa-inspired `ANSI Shadow` masthead; `npm run check`, `barena tui --snapshot`, and `npm run pack:dry-run` passed.
- 2026-07-03: Removed raster poster rendering and kept the masthead as extracted `ANSI Shadow` text rows from XiaoBa's hero, with `XIAO BA` replaced by `BARENA`; `npm run check` and `npm run pack:dry-run` passed.
- 2026-07-03: Removed hero background fill and fallback font switching; the TUI masthead now renders the extracted `ANSI Shadow` rows directly with foreground-only colors.
- 2026-07-03: Superseded the 132-column compact character-art attempt because it did not preserve the original XiaoBa hero ASCII closely enough.
- 2026-07-03: Restored a 190-column, foreground-only TUI masthead using the original XiaoBa `ANSI Shadow` FIGlet character art for all three hero rows, with `XIAO BA` replaced by `BARENA`; verified via rendered preview at `/tmp/barena-tui-preview-ansi-shadow-190.png`.
- 2026-07-03: Final verification passed for the restored TUI masthead: `npm run check`, `barena tui --snapshot --no-color`, color escape scan for no background fill, and `npm run pack:dry-run`.
- 2026-07-03: Reworked the TUI masthead into a terminal-native three-size composition matching the desired visual hierarchy: `BARENA` largest, `AGENTS CAN GROW.` second, `MAKES GROWTH REVIEWABLE.` smallest; verified via rendered color preview at `/tmp/barena-tui-preview-proportional-color.png`.
- 2026-07-03: Final three-size masthead verification passed with `npm run check` and color escape scan confirming cream/gold foreground colors with no background fill.
- 2026-07-03: Simplified the TUI masthead back to a stable terminal-native version: only `BARENA` uses ASCII art, surrounding copy is plain text, and the abandoned inline-image experiment was removed.
- 2026-07-06: Added built-in agent CI targets for opencode, XiaoBa, Hermes Agent, and OpenClaw; `npm run check` passed with 9 tests, and CLI smoke passed for `list targets`, `import agent hermes`, `run`, and Markdown report target metadata.
- 2026-07-07: Added `docs/BARENA_CLEARANCE_SKILL.md` to define Barena as an agent-facing clearance skill and recorded the follow-up installable skill milestone.
- 2026-07-14: Repositioned README, package metadata, SPEC, PLAN, GitHub description, and repository topics around Agent E2E testing; real-runtime execution remains explicitly marked as coming soon. `npm run check`, `npm run pack:dry-run`, and Mermaid target-architecture rendering passed.
- 2026-07-14: Implemented `barena.agent_e2e_case.v1`, XiaoBa evaluator preflight, OpenClaw local JSON `TargetAdapter`, strict subprocess/protocol handling, provenance-aware boundary traces, fresh-session replay, artifact assertions, coverage/confidence scorecards, `barena e2e probe`, and `barena e2e run`.
- 2026-07-14: `npm run check` passed with 14 tests; the five Agent E2E tests exercise real child-process invocation through a fake OpenClaw binary, multi-line message-file integrity, replay session isolation, invalid JSON blocking, missing binary blocking, XiaoBa seam blocking, evidence provenance, artifact verification, and no regression of the nine previous tests.
- 2026-07-14: Real local smoke returned `xiaoba_external_agent_mode_unavailable` for XiaoBa 0.1.1 and `binary_not_found` for OpenClaw; `barena e2e run docs/cases/openclaw-write-artifact.json` wrote a held/blocked scorecard with all evaluator stages blocked, target `not_started`, no invented evidence, and `confidence=none`.
- 2026-07-14: `npm run pack:dry-run`, CLI help/probe smoke, and high-resolution Mermaid target-architecture rendering passed. The package includes the example OpenClaw E2E case and fixture.
- 2026-07-14: Added the locked `docs/POSITIONING.md` product contract. It fixes Barena as Agent E2E release CI, Phase 1 as Skill-change release CI, OpenClaw as the first target, XiaoBa-CLI as the evaluator runtime, and SkillsBench as the first external case/calibration source.
- 2026-07-14: Added `barena.skill_evaluation_request.v1` and `barena.skill_evaluation.v1`, with no-Skill baseline/candidate pairing, verifier-backed truth, observed lift, replay stability, evidence quality, per-case regression protection, and deterministic clear/hold/reject reasons.
- 2026-07-14: OpenClaw attempts now use isolated workspace/state/config/session paths, stage only the selected candidate Skill, set an exact agent Skill allowlist, and require a trustworthy `openclaw skills check --agent ... --json` result before invocation. Baseline requires an empty eligible Skill set.
- 2026-07-14: Added the zero-argument keyboard TUI, local Skill/case input, OpenClaw review, attempt selection, result view, persisted NDJSON boundary-trace view, prerequisite/previous-run views, and the automation-equivalent `barena evaluate skill` command. Non-TTY zero-argument behavior remains help output and `barena tui --snapshot` preserves the legacy dashboard snapshot.
- 2026-07-14: Final verification passed with `npm run check` (19 tests), a fake-process paired evaluation proving 0% baseline versus 100% stable candidate lift, a no-effect 100%/100% hold, Skill input validation, paired blocked persistence, responsive 40/80/120-column TUI checks, real local blocked CLI smoke (`xiaoba_external_agent_mode_unavailable`, no invented trace), non-TTY help/TUI smoke, and `npm run pack:dry-run`.
- 2026-07-14: Started the XiaoBa native adaptation SuperGoal. Two read-only child Goals completed normal create/complete lifecycles for the native CLI contract and Barena architecture; a third independent verification dispatch was rejected by the agent thread limit and recorded as parent-owned sequential fallback. Parent independently verified XiaoBa 0.1.1 version/help/source contracts and rendered the updated target Mermaid successfully to `/tmp/barena-xiaoba-target.png` and poster.
- 2026-07-14: Implemented `barena.xiaoba_capability_evaluation_request.v1/result.v1`, native case loading, exact XiaoBa 0.1.1 probing, immutable input staging, per-attempt execution roots, `role`/`role_skill` execution, filesystem-authoritative normalization, Skill activation proof, Barena artifact verification, evidence copy/hash, and paired aggregation. Parent review corrected the Reviewer/Arena distinction (`run_id` vs `arena_run_id`) and relative manifest resolution against the actual XiaoBa contract.
- 2026-07-14: Added XiaoBa-first TUI choices for Skill and Role, truthful Role baseline inputs, native case selection, shared execution/result screens, and provenance-aware rendering from accepted `barena:boundary`, `xiaoba:native`, and `xiaoba:evaluator` evidence copies. Existing OpenClaw Skill navigation remains available as the secondary path.
- 2026-07-14: Added automation-equivalent native commands: `barena e2e probe --target xiaoba`, `barena evaluate skill --target xiaoba --role ...`, and `barena evaluate role --baseline-role ...`; fake CLI smokes cleared both Skill and Role cases with 0% baseline, 100% candidate, and `positive_lift`.
- 2026-07-14: Focused native tests cover probe/execution, Skill activation, Role pairing, unique roots/run IDs, no Role-root shadow, evidence hashes, missing binary, inheritance false, Skill collision, missing trace, sandbox not enforced, stale run identity, unsafe rejection, no-effect hold, TUI navigation, and native trace rendering. Final `npm run check` passed 23/23 tests, including all OpenClaw and legacy tests.
- 2026-07-14: Real no-secret XiaoBa 0.1.1 smoke reached a ready native probe, staged/snapshotted both paired arms, and stopped before model execution with `held/xiaoba_provider_unconfigured`. Both blocked attempts preserved copied/hashed Barena boundary evidence; the result recorded `three_evaluator_agent_sessions=false`, `evaluator_target_process_isolated=false`, and `network_disabled_is_hard_boundary=false`.
- 2026-07-14: Final `npm run pack:dry-run` passed after its prepack check (23/23 tests, 170 package files). Current and target Mermaid architecture diagrams rendered successfully to `/tmp/barena-current-final.png` and `/tmp/barena-target-final.png`, with high-resolution poster variants.
- 2026-07-15: Added the canonical core evaluation DAG to README/SPEC and a dedicated responsive TUI view. Mermaid rendered successfully to `/tmp/barena-core-dag.png` plus its poster variant; `npm run check` passed 24/24 tests, including 40/80/120-column DAG coverage.

## Risks / Open Questions

- MVP1 adapter is deterministic and does not invoke XiaoBa `AgentSession`; scorecards record `xiaoba_invoked: false`.
- XiaoBa 0.1.1 Arena only supports skill/role subjects; the real three-evaluator OpenClaw vertical slice remains blocked until XiaoBa owns an external target-driver seam.
- OpenClaw is not installed locally, so default verification uses an injected fake binary and a no-token real preflight. Live model smoke must be explicit and budgeted.
- OpenClaw local tool policy is not an OS sandbox. Until Barena adds a container boundary, reports must say `isolation=policy_only`.
- Boundary traces prove observed input/output/process/workspace behavior but cannot prove hidden target reasoning or native tool sequencing.
- GitHub import clones and scans only; it does not run install scripts or arbitrary repository code.
- Static scanning is pattern-based and should not be treated as a complete malware detector.
- XiaoBa has no subject-free `base` Arena mode. A no-Skill base-agent or base-versus-Role claim is blocked unless a truthful explicit baseline is available; Barena will not synthesize a no-op subject.
- XiaoBa native Arena is a composite CLI contract, not a single target call. Treating it as a `TargetAdapter` would lose evaluator/target/replay/scorecard semantics.
- XiaoBa Role snapshots currently resolve installed Role identities; arbitrary Role-directory execution may not be supported and must remain blocked unless the CLI contract proves it.
- Native Arena output is retained inside each Barena attempt and every accepted boundary/native/evaluator/verifier/debug ref is copied and hash-stamped before a complete result can clear.

## Status Maintenance Rules

Update this file when architecture, milestone status, verification evidence, or risk posture changes. Keep historical command dumps out; record only effective current evidence. Product category or Phase 1 wedge changes must update `docs/POSITIONING.md` first and follow its change-control rules.
