# Barena Implementation Plan

Updated 2026-07-27.

## Current milestone: evaluator/target separation

Barena was extracted from the XiaobaOS Arena idea, but an independent product cannot call the embedded Arena as its evaluator. The current milestone makes Barena the evaluator control plane and treats XiaobaOS as an ordinary Agent target.

### Completed

- [x] Freeze the product position as Agentic Eval and Release for Agent Harness evolution.
- [x] Document the evaluator/target ownership boundary.
- [x] Add `XiaobaTargetAdapter` over `xiaoba chat --role --message [--skill]`.
- [x] Isolate baseline and candidate base-Skill roots and workspaces.
- [x] Route generic Agent E2E and paired Skill evaluation through the XiaobaOS adapter.
- [x] Materialize `skillsbench:starter` as `barena.agent_e2e_case.v1` for XiaobaOS.
- [x] Remove legacy native-runner imports from CLI, guide, TUI execution, E2E, and public evaluation exports.
- [x] Exclude legacy Arena executable modules from the production TypeScript build.
- [x] Add subprocess regression coverage proving no XiaobaOS invocation contains `arena`.
- [x] Rewrite README around Harness evolution, fixed Replay, honest evidence, and current limitations.

### Verified

- [x] TypeScript build and focused ordinary-chat tests pass.
- [x] Complete repository suite passes: 140 tests, 0 failures, 0 skips.
- [x] A fresh `barena@0.1.0` tarball installs in an empty consumer and runs `--version` and `--help`.
- [x] Installed `dist` excludes the legacy XiaobaOS Arena runner, native input builder, and live-policy executor.
- [x] Real local XiaobaOS 0.2.0 doctor reports the ordinary `chat` target contract ready without making a model call.
- [x] Final diff passes whitespace checks and the public-route boundary test proves no Arena runner import.

### Next product slices

- [ ] Introduce the canonical `AgentRuntimeAdapter` lifecycle (`probe/openSession/sendTurn/cancel/close`) and keep `TargetAdapter.execute(...)` as a temporary Replay compatibility facade.
- [ ] Add Barena OTel instrumentation, W3C Trace Context propagation, and an OTLP gateway with provenance and redaction.
- [ ] Migrate boundary NDJSON evidence to OTel spans/events without fabricating Runtime-native detail.
- [ ] Add built-in Claude Code and Codex Runtime adapters; align XiaobaOS and OpenClaw behind the same lifecycle.
- [ ] Implement Role A/B through ordinary target adapters; never restore Arena fallback.
- [ ] Add Harness-config A/B so model/Prompt/Tool/Runtime changes are first-class selections, not only Skill changes.
- [ ] Implement `barena replay`, `barena explore`, and `barena compare` as the locked public surface, retaining existing commands as compatibility aliases during migration.
- [ ] Implement adaptive multi-turn User Simulator campaigns as the Barena-owned Explore engine.
- [ ] Implement Inspector issue extraction and Reviewer attribution from persisted Barena/target evidence.
- [ ] Emit evidence-backed Replay Case candidates from Explore and promote them only through an explicit user action.
- [ ] Validate real OpenClaw and Hermes installations beyond deterministic contract fixtures.
- [ ] Expand SkillsBench-derived coverage beyond the one-task starter while preserving provenance and non-official labeling.

## Evidence rules

- Target completion never bypasses Barena's verifier.
- Boundary evidence must not be relabeled as native evidence.
- Native trace references are accepted only when ordinary target execution genuinely emits them.
- Fixed Replay marks UserCat/Inspector/Reviewer `not_applicable` until those stages actually run.
- `policy_only` never means a hard OS sandbox.
- Missing prerequisites yield held/blocked results rather than fallback or simulated success.

## Historical compatibility

Legacy XiaobaOS Arena result types remain for read-only run catalog/TUI inspection and source-level migration tests. The old executable runner/input/live-policy modules are excluded from the production build and public package exports. They should move under a dedicated test fixture or migration package after historical persisted runs no longer require compatibility work.
