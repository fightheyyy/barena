# Barena PLAN

## Current Status

The product category remains frozen in [`docs/POSITIONING.md`](POSITIONING.md): Agent E2E release CI. This plan revision keeps XiaobaOS as the first and highest-evidence native target while adding a distinct portable verifier profile for OpenClaw, Hermes, and other CLI agents. XiaobaOS native Arena suites/cases are the first executable case source; SkillsBench-derived packs are an implemented external calibration source, not the product category.

Barena now has first-party XiaobaOS 0.1.1 and 0.2.0 native Role/Skill release paths, a built-in OpenClaw portable adapter, and a strict JSON driver contract for Hermes/custom CLI agents. The portable profile clears only from complete Barena boundary/workspace/verifier/session evidence, never starts a XiaobaOS evaluator process, never claims native/evaluator traces, and caps confidence at medium.

The SkillsBench-derived case-source layer is implemented on the XiaobaOS native path. It pins upstream revision/task hashes, records adaptations, preserves prompt fidelity, and adds trusted structured-JSON verification without claiming BenchFlow/Docker runtime compatibility. The XiaobaOS validation pack now projects the same pinned `dialogue-parser` task into an explicit-spec fixed replay case and a low-information UserCat E2E boundary case with one shared hidden graph oracle. The executable parser and Graphviz requirements are explicit omissions because Barena does not execute subject-authored verifier code in this calibration. Deterministic contract coverage proves the projection and paired evaluation plumbing. A local additive XiaobaOS audit contract now passes live preflight and reached the real provider boundary; the persisted smoke stopped fail-closed on expired OAuth before the candidate arm, so no live effectiveness lift is claimed.

The product evaluation DAG is visible in the README and repository SPEC. The interactive TUI retains the complementary execution map: it separates XiaobaOS native evidence from portable boundary evidence, then joins the selected profile with Barena's artifact verifier before paired aggregation and the final release gate.

The native and portable paths remain distinct. XiaobaOS native evaluation does not pass through `TargetAdapter`; versions 0.1.1 and 0.2.0 use XiaobaOS-owned UserCat/Inspector/Reviewer pipeline stages and only the target emits native AgentSession traces. Portable evaluation uses `TargetAdapter` plus Barena's deterministic verifier, marks evaluator stages `not_applicable`, and caps boundary-only confidence at medium. Neither path substitutes or fabricates native evaluator evidence.

First-run onboarding now uses `barena` / `barena guide`. It imports or snapshots a Skill, selects XiaobaOS/OpenClaw/portable execution, validates an existing case or creates a clearly labeled starter smoke case, displays the effective agent/env/network/timeout/replay or live-policy budget, previews the exact automation command before writes, and requires separate preparation and paid-execution confirmations. `barena tui` remains the advanced evidence workspace.

The completed onboarding P0 adds project-scoped `barena init`, target-aware provider/driver diagnostics, and a `skillsbench:starter` alias. Target Agents continue to own their provider authentication; Barena stores only environment-variable references and keeps deterministic verification as the default portable evaluator.

## Milestones

- [x] Define repository architecture and SuperDev docs.
- [x] Create TypeScript CLI scaffold.
- [x] Implement local skill subject import.
- [x] Implement clean run directory creation.
- [x] Implement UserCat, InspectorCat, ReviewerCat MVP contracts.
- [x] Implement deterministic XiaobaOS-compatible adapter boundary for scaffold verification.
- [x] Add neutral runtime contracts inspired by XiaobaOS without importing XiaobaOS source.
- [x] Add evidence-first scorecard fields for stages, replay attempts, artifacts, and debug refs.
- [x] Add tests for cleared and unsafe decisions.
- [x] Add GitHub import command path.
- [x] Add scan, replay, verifier, report, list, doctor CLI surfaces.
- [x] Add package `files`, `main`, `types`, `exports`, and `prepack`.
- [x] Document honest XiaobaOS-compatible adapter stance.
- [x] Add XiaobaOS-style black/gold `ANSI Shadow` TUI masthead.
- [x] Add a canonical Barena core evaluation DAG to README, SPEC, and the responsive interactive TUI.
- [x] Document Barena as an agent-facing clearance skill.
- [ ] Retire or clearly isolate the legacy deterministic adapter once all consumers use native or portable evaluation.
- [x] Add native `role + skill` evaluation support through XiaobaOS `role_skill`.
- [ ] Create installable `barena-clearance` skill.
- [x] Add static scan policy for external GitHub skills.
- [x] Add built-in agent CI target metadata for opencode, XiaobaOS, Hermes Agent, and OpenClaw.
- [x] Reposition public documentation around Agent E2E testing while preserving an honest deterministic MVP boundary.
- [x] Separate XiaobaOS native evaluation from pluggable target-agent adapters in the architecture.
- [x] Lock the product positioning, Phase 1 Skill-change wedge, non-goals, public language, and change-control rules.
- [x] Define and implement `barena.agent_e2e_case.v1` for task, fixture, artifact assertion, replay, timeout, and isolation policy.
- [x] Implement provenance-aware Barena boundary traces with optional native trace references.
- [x] Implement the legacy XiaobaOS evaluator-runtime preflight and fail closed when its external-agent mode is unavailable.
- [x] Implement the local-only OpenClaw JSON CLI `TargetAdapter` with strict protocol parsing.
- [x] Add `barena e2e probe` and `barena e2e run <case.json>`.
- [x] Add artifact assertion, replay, evidence coverage, and confidence to Agent E2E scorecards.
- [x] Add focused fake-binary tests for subprocess interaction, protocol failure, blocked behavior, replay isolation, and evidence provenance.
- [x] Add the paired Skill evaluation request/result contract and deterministic baseline/candidate aggregation.
- [x] Bind isolated OpenClaw baseline/candidate workspaces with explicit Skill allowlists and eligibility preflight.
- [x] Preserve the capability evaluation TUI under explicit `barena tui` and make zero-argument interactive `barena` open the first-run guide while preserving non-TTY help behavior.
- [x] Add result, blocked-state, and persisted boundary-trace views to the TUI.
- [x] Add project config initialization and config-backed evaluation defaults.
- [x] Add target/provider-aware doctor diagnostics without retaining secret values.
- [x] Add a cross-profile SkillsBench starter-suite selector and structured portable verification.
- [x] Add the automation-equivalent `barena evaluate skill` command.
- [x] Amend the locked positioning contract with evidence for XiaobaOS as the first native target and OpenClaw as the first external target.
- [x] Define the native/portable dual-path target architecture with logically separate XiaobaOS native and external target planes.
- [x] Confirm and pin the exact XiaobaOS native CLI, subject, suite, output, trace, and isolation contract.
- [x] Add generalized Role/Skill paired evaluation contracts without breaking `barena.skill_evaluation.v1` reads.
- [x] Implement XiaobaOS native Arena probe/execution, evidence copy/hash, normalization, and honest blocked reasons.
- [x] Implement same-Role Skill comparison and explicit baseline-Role comparison.
- [x] Add XiaobaOS/Skill/Role choices and truthful baseline inputs to the zero-argument TUI and automation CLI.
- [x] Add fake XiaobaOS contract tests plus a real no-secret local smoke and trace/result rendering verification.
- [ ] Optionally add a stronger external-target evaluator seam upstream in XiaobaOS without replacing portable verification.
- [ ] Add cross-version regression comparison and flake reporting.
- [x] Add `barena.xiaoba_case_pack.v1` with SkillsBench source provenance and fail-closed compatibility checks.
- [x] Add trusted structured-JSON artifact assertions and a SkillsBench-derived dialogue-graph calibration fixture.
- [x] Add a two-lane XiaobaOS validation pack that maps one pinned SkillsBench task to fixed replay and UserCat Agent E2E cases without duplicating task provenance.
- [x] Implement and test an additive XiaobaOS live audit contract locally, including provider/model pinning, physical-call telemetry, token/retry limits, macOS sandbox compatibility, and fail-closed cleanup.
- [x] Add subscription-entitlement live policies with zero-dollar accounting and hard call/token/retry enforcement instead of inventing per-token prices.
- [x] Preserve byte-identical baseline/candidate task prompts without Skill-name treatment cues.
- [x] Support exact XiaobaOS native contracts 0.1.1 and 0.2.0 with `xiaobaos` public CLI aliases and stable legacy wire identifiers.
- [x] Implement `portable_verifier` orchestration with `boundary_verified` evidence, no evaluator traces, and confidence capped at medium.
- [x] Enable the built-in OpenClaw adapter through the portable verifier and preserve Skill eligibility/baseline-leak protections.
- [x] Implement the strict portable JSON driver contract for Hermes and custom CLI agents.
- [x] Package runnable offline examples and prove the tarball in a clean install directory.
- [x] Add a first-run `barena guide` that imports local/GitHub/downloaded Skills, selects XiaobaOS/OpenClaw/portable targets, previews the plan, and executes after confirmation.
- [x] Expose paired Skill evaluation for Hermes/custom portable drivers through the public CLI.
- [x] Reorganize help and TUI onboarding around user intent rather than internal runtime vocabulary.
- [x] Harden the TUI with contextual steps, Hermes/custom driver setup, session/evidence review, explicit execution confirmation, recoverable errors, and 24-row rendering bounds.

## Next Steps

1. Publish Barena 0.1.0 with the portable verifier path, SkillsBench-derived validation pack, and released-XiaobaOS live limitation stated explicitly.
2. Refresh the local provider authorization, run the complete SkillsBench baseline/candidate manifest, and publish the sanitized persisted report.
3. Review and release the additive physical provider-call safety contract in XiaobaOS so the live path is available without a local patch.
4. Smoke a real local OpenClaw binary and a real Hermes wrapper before making live-runtime claims for those targets.
5. Add cross-version comparison and flake reporting without weakening the paired case contract.

## Owners

- Parent Codex agent owns architecture, integration, and final verification.
- `/root/cli_guide_tests` implemented the guided CLI and portable paired regression tests; `/root/cli_onboarding_docs` updated README/TUI onboarding; `/root/cli_ux_audit` performed a read-only P0/P1 review. Each completed its child-goal lifecycle, and the parent reviewed every accepted change or finding before final verification.
- The spawn surface did not expose the requested `gpt-5.6-sol` / `xhigh` overrides, so the dispatch ledger records the runtime fallback and the parent treats child findings as advisory rather than final acceptance.
- Barena contracts remain independent from XiaobaOS and OpenClaw source trees; integration occurs through CLIs and explicit manifests.

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
- README and package metadata lead with Agent E2E testing, identify XiaobaOS native Role/Skill evaluation as implemented, and distinguish portable driver compatibility from live-runtime validation.
- No Dashboard, Electron, Pet, Feishu, Weixin, `node_modules`, logs, output, or secrets are copied into Barena.
- `TargetAdapter` executes an injected fake OpenClaw process with `shell: false`, preserves multi-line prompt bytes through a message file, and strictly parses the complete JSON stdout envelope.
- The OpenClaw adapter emits Barena-owned boundary evidence for input, stdout/stderr, process status, and workspace artifacts without fabricating target-native tool calls.
- Every replay gets a unique target session and isolated state paths.
- A missing OpenClaw binary/config or incompatible CLI yields a structured `blocked` target result.
- Portable OpenClaw/Hermes/custom runs do not depend on a XiaobaOS evaluator process; missing target binaries, driver capability, verifier evidence, or Skill-binding proof fail closed with structured results.
- Agent E2E scorecards distinguish target completion from verifier success and record evidence coverage/confidence.
- Interactive `barena` can select a local Skill, OpenClaw, case, and total attempts; it never labels an unproven Skill injection as evaluated.
- The guide displays the effective case agent/profile, environment names, declared network/isolation, timeout, replay/session count or XiaobaOS live-policy budget before writes; invalid input retries locally, cancellation before preparation writes nothing, and existing snapshots default to no replacement.
- A starter case is labeled as onboarding smoke only, refuses to overwrite an existing case, and is never presented as production-quality release evidence.
- The paired Skill result reports verifier-backed truth, observed Skill lift, stability/quality, evidence coverage, and a deterministic release reason.
- TUI trace views render persisted NDJSON provenance and display an explicit no-trace message when preflight blocks target execution.
- Non-interactive `barena evaluate skill` produces the same persisted evaluation artifact as the TUI.
- Existing deterministic clearance tests remain green.
- XiaobaOS native Skill evaluation compares the same explicit Role without and with the candidate Skill, or returns a structured baseline blocker.
- XiaobaOS native Role evaluation requires an explicit baseline Role and pins common suite/model/tool conditions.
- XiaobaOS native attempts preserve original Arena scorecard/native traces/evaluator refs and copy/hash them into the Barena run package.
- XiaobaOS native results explicitly record `three_evaluator_agent_sessions=false`, `evaluator_target_process_isolated=false`, and `network_disabled_is_hard_boundary=false`; UI/docs never overstate the current isolation or call the stages three independent evaluator AgentSessions.
- The TUI and automation CLI can select XiaobaOS plus Skill or Role and expose the same persisted paired result.
- README and TUI expose the same core DAG, distinguish the native Reviewer score from the Barena verifier and final gate, and remain readable at 40, 80, and 120 terminal columns.
- XiaobaOS native and OpenClaw portable paths coexist; existing contract tests remain green.
- A pinned SkillsBench-derived pack rejects upstream task-byte drift and persists repository, revision, task ID, task hash, adaptations, and pack fingerprint.
- Baseline and candidate receive byte-identical canonical prompts; candidate activation is proven independently from native trace evidence.
- Structured JSON verification rejects semantic graph near misses, and the persisted Markdown report labels the run as an unofficial derived projection.

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
- 2026-07-19: Added `barena.xiaoba_case_pack.v1`, a pinned SkillsBench-derived `dialogue-parser` calibration pack, canonical prompt preservation, structured JSON/graph verification, source provenance in requests/results/reports, and CLI `--case-pack` support. The copied upstream task bytes match SHA-256 `d14e9102a433abcdb7cbab8a02e082b698fb87eb50fd9e8bc95c2ebb8d9cc1ab` at commit `5720102e3d6b0d3471b9715995ff96144d9eefb7`.
- 2026-07-19: Parent acceptance proved the deterministic fake-XiaoBa slice at baseline `0/2` versus candidate `2/2`, candidate-only activation, semantic near-miss rejection, persisted Markdown provenance/disclaimer fields, and `cleared/positive_lift`. A built CLI `--case-pack --preflight-only` smoke returned `held/live_preflight_only`, reserved 120 provider calls, recorded zero attempts, and kept `model_invoked=false`; `--case` plus `--case-pack` failed with exit 3.
- 2026-07-19: `npm run pack:dry-run` passed after `npm run check` with 149/149 tests. The 228-file package includes the calibration manifest, source/adaptation notes, task copy, fixture, candidate Skill, and compiled case-pack/verifier modules.
- 2026-07-19: Added exact XiaobaOS 0.2.0 support while preserving pinned 0.1.1 requests, stable `barena.xiaoba_*.v1` wire contracts, the `xiaoba` executable, and legacy CLI flags. Real local `barena e2e probe --target xiaobaos` returned ready against XiaobaOS 0.2.0; conflicting new/legacy flag values returned exit 3.
- 2026-07-19: Added `portable_verifier`, the built-in OpenClaw path, `barena.portable_target_probe/request/result.v1`, strict prompt/workspace/Skill/session evidence, replay aggregation, and honest `boundary_verified` reports with evaluator stages `not_applicable`, no native trace, `policy_only` isolation, and confidence capped at medium.
- 2026-07-19: `npm run check` passed 154/154 tests. Focused coverage includes OpenClaw `0% → 100%` Skill lift, no-effect hold, Skill leak/invisibility, portable protocol/malformed/timeout/verifier/unsafe/session failures, prompt hash fidelity, and fresh replay workspaces.
- 2026-07-19: `npm run pack:dry-run` passed with 154/154 tests. The final 239-file tarball, including Apache-2.0 license and repository metadata, installed into `/tmp/barena-final-install.FW1UgI`; `barena --version`, portable probe, and the packaged offline two-attempt E2E passed with `cleared/pass`, `boundary_verified`, and `confidence=medium`.
- 2026-07-19: Finished the intent-first CLI: `barena`/`barena guide` now handle local, GitHub, and downloaded-catalog Skills; XiaobaOS, OpenClaw, and portable drivers; existing or starter cases; truthful baseline/evidence/cost review; safe snapshot replacement; local retry/cancel; and separate preparation/execution confirmations. `barena tui` is labeled as the advanced evidence workspace.
- 2026-07-19: At that checkpoint, `npm run check` passed all 162 tests then present and `npm run pack:dry-run` listed 243 package files. A real TTY smoke reviewed the effective OpenClaw case and 2+2 sessions, then cancelled with no writes. The globally linked CLI resolved to this checkout, `barena --version` returned `0.1.0`, `barena --help` led with the guide, non-TTY `barena guide` exited `3`, and non-TTY zero-argument `barena` printed help with exit `0`.
- 2026-07-19: Reworked `barena tui` from a code-shaped evidence menu into an intent-led keyboard workflow. It now supports XiaobaOS Skill/Role, OpenClaw, and Hermes/custom portable drivers; fits normal screens within 24 rows; discloses total sessions and evidence profile; requires `y` after a dedicated cost boundary; and returns validation/runtime failures to the relevant step without discarding inputs.
- 2026-07-20: Open-source release hardening added Apache-2.0 packaging, Node 18/current-LTS CI, contribution and private vulnerability-reporting guidance, packaged README assets, and precise exclusions for local SuperDev/audit files. Personal absolute-path and high-confidence credential scans returned no matches; `npm audit --omit=dev` reported zero vulnerabilities.
- 2026-07-20: Corrected the future live-contract simulator so deterministic Inspector and internal Reviewer/replay stages no longer fabricate provider calls. Released XiaobaOS 0.2.0 still failed closed before paid execution because `arena live-contract --json` was unavailable; the real native structural probe remained ready.
- 2026-07-20: Final local release-candidate gates passed on both declared compatibility edges: Node 18.20.8 completed 166/166 tests and Node 25.9.0 `npm run check` completed 166/166. The release fixed Node 18 immutable-snapshot cleanup by restoring owner permissions only on real directories inside Barena-owned scratch, skipping symlinks, and retaining fail-closed deletion verification; readonly-tree and external-symlink regression tests cover the boundary. The physical-call smoke also passed 10/10 additional serial repetitions.
- 2026-07-20: The final 245-file package passed prepack, installed into an empty consumer, and completed version/help, portable probe, and two-attempt offline E2E with `cleared/pass`, `boundary_verified`, and medium confidence. Real guide/TUI TTY cancellation, non-TTY exit codes, global-link version, `npm audit --omit=dev`, credential/absolute-path scans, `git diff --check`, and package-content checks also passed.
- 2026-07-20: Added strict project-scoped `.barena/config.json`, `barena init`, `barena config show/path`, config-backed `barena eval`, and target-aware `barena doctor`. Provider credentials remain target-owned: Barena persists and reports environment-variable names only, passes only allowlisted names, and never serializes their values.
- 2026-07-20: Added `barena list suites` and `skillsbench:starter`, materializing the pinned one-task SkillsBench-derived calibration for XiaobaOS native, OpenClaw, and portable JSON drivers. Portable cases now reuse trusted structured JSON/graph verification; the suite remains explicitly unofficial and is not presented as a full SkillsBench score.
- 2026-07-20: Node 25.9.0 `npm run check` and a direct Node 18.20.8 build/test both passed 169/169 tests. A freshly packed `barena@0.1.0` tarball installed in an empty consumer, loaded the bundled suite, initialized and diagnosed a Hermes-compatible driver from project config, and completed the packaged two-attempt offline E2E with `cleared/pass`.
- 2026-07-21: Added the SkillsBench-derived XiaobaOS validation manifest with explicit-spec fixed replay and low-information UserCat E2E cases sharing the pinned `dialogue-parser` task, fixture, Skill, and structured graph oracle. The loader permits multiple unique projections of one upstream task only when their source path and verified hash agree, while deduplicating persisted `task_ids`. The executable parser and Graphviz requirements are recorded omissions; no subject-authored verifier code is executed. Credential-free verification confirmed XiaobaOS 0.2.0 structural readiness and the expected `arena live-contract --json` blocker; no model call was started.
- 2026-07-21: Added a local XiaobaOS `arena live-contract --json` audit seam, physical provider-call telemetry, provider/model and token/retry enforcement, macOS Seatbelt path handling, and guaranteed scratch cleanup. Barena added runtime-declared call planning and subscription-entitlement policies. Full Barena regression passed 175/175 tests; XiaobaOS full regression passed. A persisted real smoke (`xiaoba-skill-eval-20260721100935-f06681`) reached the baseline provider request and stopped on `PROVIDER_AUTH_ERROR` 401; the target trace reported `0/0` tokens, billing usage was unavailable, and no retry occurred. Redaction and cleanup passed and the candidate arm did not start.

## Risks / Open Questions

- The legacy MVP1 adapter is deterministic and does not invoke a XiaobaOS `AgentSession`; its scorecards record `xiaoba_invoked: false` and must not be confused with the native path.
- Portable clearance is lower-evidence than XiaobaOS native clearance and must remain visibly labeled `boundary_verified`.
- OpenClaw adapter tests use an injected fake binary unless a real local binary smoke is explicitly run; do not claim live OpenClaw model validation from fixtures.
- `barena` is not yet published to the npm registry. The current verified handoff is the generated `barena-0.1.0.tgz`; `npm install barena` becomes valid only after an authorized publish.
- OpenClaw local tool policy is not an OS sandbox. Until Barena adds a container boundary, reports must say `isolation=policy_only`.
- Boundary traces prove observed input/output/process/workspace behavior but cannot prove hidden target reasoning or native tool sequencing.
- GitHub import clones and scans only; it does not run install scripts or arbitrary repository code.
- Static scanning is pattern-based and should not be treated as a complete malware detector.
- XiaobaOS has no subject-free `base` Arena mode. A no-Skill base-agent or base-versus-Role claim is blocked unless a truthful explicit baseline is available; Barena will not synthesize a no-op subject.
- XiaobaOS native Arena is a composite CLI contract, not a single target call. Treating it as a `TargetAdapter` would lose evaluator/target/replay/scorecard semantics.
- XiaobaOS Role snapshots currently resolve installed Role identities; arbitrary Role-directory execution may not be supported and must remain blocked unless the CLI contract proves it.
- Native Arena output is retained inside each Barena attempt and every accepted boundary/native/evaluator/verifier/debug ref is copied and hash-stamped before a complete result can clear.
- Released XiaobaOS 0.2.0 does not expose Barena's live safety capability/telemetry contract. Native structural compatibility is ready, and the boundary is implemented on a local additive patch, but unpatched installs must remain `held/live_runtime_contract_unsupported` until XiaobaOS publishes it.

## Status Maintenance Rules

Update this file when architecture, milestone status, verification evidence, or risk posture changes. Keep historical command dumps out; record only effective current evidence. Product category or Phase 1 wedge changes must update `docs/POSITIONING.md` first and follow its change-control rules.
