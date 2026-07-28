# Barena Implementation Plan

Updated 2026-07-28.

## Current milestone: v0.1 MVP release closure

The evaluator/target separation is complete. The current milestone closes a publishable
v0.1 MVP around XiaoBaOS Explore, fixed-case/Skill comparison, verifier-backed release
evidence, and an honest public validation package. Cross-Runtime Explore and the final
RunSet-to-RunSet Compare surface remain post-v0.1 product slices.

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
- [x] Replace the zero-argument Skill-only entry with a Barena product home that selects mode, local Runtime, and Runtime-native target.
- [x] Add a Runtime registry that detects XiaoBaOS, OpenClaw, Claude Code, Codex, and Hermes while distinguishing installation from Explore support.
- [x] Add the canonical XiaoBaOS `AgentRuntimeAdapter` lifecycle with Role enumeration and explicit full-history replay.
- [x] Add the XiaoBaOS Explore DAG: real UserCat → target Role → InspectorCat → ReviewerCat.
- [x] Add a loopback OTLP/HTTP receiver, protobuf decoding, span NDJSON persistence, and target-native evidence completeness.
- [x] Reuse the existing full-screen TUI shell for `barena`, interactive
      `barena explore`, Runtime/Role selection, review, confirmation, and result.
- [x] Replace the TUI's rectangular frame with an open canvas and show live,
      evidence-derived UserCat, target, Inspector, and Reviewer activity.
- [x] Replace the experimental natural-language-first home with a
      selection-first Explore shell: task → Runtime → explicit Base/Role →
      natural-language objective Composer with optional `/skill`, preserving
      the ASCII brand and automation contracts.
- [x] Narrow UserCat to Scenario-style end-user role-play while keeping
      evidence sufficiency, failure analysis, and scoring in Inspector/Reviewer.
- [x] Publish the 24-task SkillsBench v1.1 method-validation package with
      immutable JSON/Markdown results, deterministic poster sources, source
      selection, compatibility shim, and explicit statistical/evidence caveats.
- [x] Expose real `barena explore`, `barena replay`, and `barena compare`
      product commands over the implemented Explore, fixed-Case, and paired
      Skill engines; reject unknown commands even when combined with `--help`.

### Verified

- [x] TypeScript build and focused ordinary-chat tests pass.
- [x] Complete repository suite passes: 157 tests, 0 failures, 0 skips.
- [x] Deterministic product-CLI acceptance reaches all three real engines:
      Explore passes with 7 OTLP spans, Replay clears across 2 attempts, and
      Compare clears a verifier-backed `0/1 → 1/1` positive lift.
- [x] Real 80×24 TTY smoke reaches the reviewed XiaoBaOS Base + installed
      Skill Explore plan and cancels before any paid model call.
- [x] Package and fresh-install smoke succeed with the Explore engine, Runtime
      adapters, TUI, example Scenario, public validation JSON, and main poster.
- [x] A fresh `barena@0.1.0` tarball installs in an empty consumer and runs `--version` and `--help`.
- [x] Installed `dist` excludes the legacy XiaobaOS Arena runner, native input builder, and live-policy executor.
- [x] Real local XiaobaOS 0.2.0 doctor reports the ordinary `chat` target contract ready without making a model call.
- [x] Final diff passes whitespace checks and the public-route boundary test proves no Arena runner import.
- [x] Public SkillsBench evidence integrity passes: selection SHA and poster
      validation ID match; 144 terminal rollouts, 90 verifier-admitted results,
      and 36 strict matched pairs reproduce the published summary.

### Next product slices

- [x] Introduce the canonical `AgentRuntimeAdapter` lifecycle (`probe/openSession/sendTurn/cancel/close`) for XiaoBaOS Explore and keep `TargetAdapter.execute(...)` as a temporary Replay compatibility facade.
- [ ] Add Barena-owned evaluator/boundary OTel instrumentation and real W3C parent propagation where each Runtime surface supports it.
- [ ] Migrate boundary NDJSON evidence to OTel spans/events without fabricating Runtime-native detail.
- [ ] Add built-in Claude Code and Codex Runtime adapters; align XiaobaOS and OpenClaw behind the same lifecycle.
- [ ] Implement Role A/B through ordinary target adapters; never restore Arena fallback.
- [ ] Add Harness-config A/B so model/Prompt/Tool/Runtime changes are first-class selections, not only Skill changes.
- [x] Implement the v0.1 `barena replay` and `barena compare` orchestration
      commands over existing verified engines.
- [ ] Migrate Replay behind `AgentRuntimeAdapter`, add compatible RunSets, and
      make `barena compare --baseline/--candidate` consume them directly.
- [x] Implement bounded adaptive multi-turn User Simulator campaigns for XiaoBaOS Role Explore.
- [x] Implement Inspector issue extraction and Reviewer single-run attribution from persisted boundary, workspace, and OTel evidence.
- [ ] Emit evidence-backed Replay Case candidates from Explore and promote them only through an explicit user action.
- [ ] Validate real OpenClaw and Hermes installations beyond deterministic contract fixtures.
- [x] Publish the existing 24-task SkillsBench-derived method validation while
      preserving provenance, evidence exclusions, and non-official labeling.

## Evidence rules

- Target completion never bypasses Barena's verifier.
- Boundary evidence must not be relabeled as native evidence.
- Native trace references are accepted only when ordinary target execution genuinely emits them.
- Fixed Replay marks UserCat/Inspector/Reviewer `not_applicable` until those stages actually run.
- `policy_only` never means a hard OS sandbox.
- Missing prerequisites yield held/blocked results rather than fallback or simulated success.

## Historical compatibility

Legacy XiaobaOS Arena result types remain for read-only run catalog/TUI inspection and source-level migration tests. The old executable runner/input/live-policy modules are excluded from the production build and public package exports. They should move under a dedicated test fixture or migration package after historical persisted runs no longer require compatibility work.
