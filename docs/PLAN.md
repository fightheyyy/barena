# Barena Implementation Plan

Updated 2026-08-19.

## Active milestone: Explore product polish

- [x] Make `barena explore` enter the natural objective Composer directly when
      XiaoBaOS and the Base profile are unambiguous.
- [x] Add `/agent` alongside `/skill` as progressive target override instead of
      mandatory Runtime/Role setup screens.
- [x] Reduce the plan preview to target, focus, objective and one paid-run
      confirmation; keep implementation diagnostics out of the main path.
- [x] Lead the result with behavior findings, exact evidence and generated
      Replay Case candidates.
- [x] Verify the new path with reducer/render tests, the complete test suite and
      a real XiaoBaOS run.
- [ ] Record and export one Screen Studio demo of the complete journey.

## Active milestone: DeepSeek Harness release compatibility

- [x] Route DSH target turns through the public headless CLI and a run-private
      Profile while keeping evaluator roles on XiaoBaOS.
- [x] Accept a validated Catena DSH Plugin bundle as an optional candidate.
- [x] Disable package lifecycle scripts during private Profile installation and
      verify a Catena-generated configuration bundle against real DSH.
- [x] Commit and publish the DSH adapter, CLI/TUI surface and fixtures.

## Current milestone: v0.6 Barena MVP1

The publishable CLI evaluator, XiaoBaOS Explore, verifier-backed Replay/Compare,
Go/PostgreSQL evolution control plane, LangWatch-derived Trace subsystem, and
Trace -> Issue -> Case -> Replay -> Release browser workflow are complete.
The current milestone gives the cloud side an executable Agent brain and a
demoable deployment boundary: Barena Platform embeds one XiaoBaOS evaluator/evolution
Runtime with exactly four allowed roles (`UserCat`, `InspectorCat`,
`ReviewerCat`, `EvolutionCat`), while Barena remains the evaluation and release
engine.

The target Agent Runtime remains external. Platform HTTP Explore owns subject
conversation orchestration; the embedded XiaoBaOS Runtime owns formal
evaluator/evolution role turns; the TypeScript Engine owns deterministic
Replay, artifact verification, and Release Check; Go owns workflow and durable
records. Local/private subject execution remains beside the target via CLI.

### Boundary cutover: local execution, Catena evidence/evolution

- [x] Make local Explore/Replay/Compare and verifier output authoritative when
      Catena is unavailable.
- [x] Accept the standalone Catena API key and canonical `/v1` ingress paths
      while retaining explicit legacy-proxy compatibility.
- [x] Forward current-Run OTLP and synchronize one immutable Run Bundle only
      after local evidence is sealed.
- [x] Record `pending/synced/failed` synchronization state without converting a
      local pass/fail/blocked result into a network failure.
- [ ] Pull Catena draft candidates/Cases into the existing local Replay path.
- [x] Treat Platform HTTP Explore and cloud Barena execution as legacy demo
      compatibility; Catena's cloud Runtime is evolution-only.

### Embedded Runtime stop metrics

- [x] Probe one configured XiaoBaOS installation and verify all four cloud
      roles without a model call.
- [x] Execute one allowlisted role turn through the ordinary XiaoBaOS chat loop
      with isolated workspace, deadline, cancellation, and telemetry context.
- [x] Reject every functional/target Role at the cloud Runtime boundary.
- [x] Expose a sanitized Runtime manifest through Go and the authenticated Web.
- [x] Show Runtime readiness and the four role responsibilities in the Barena
      product surface without implying that target Agents are cloud-hosted.
- [x] Pass fake-runtime tests plus a real local four-role probe.

### Platform HTTP Explore stop metrics

- [x] Select a registered HTTP Agent, describe a behavior, and finish a real
      Scenario Explore from the browser.
- [x] Surface top-level retained Trace IDs and adopt terminal Scenario facts
      idempotently through the authenticated server boundary.
- [x] Store no HTTP Agent credential or arbitrary request template in Go.
- [x] Send the adopted Run through Issue -> immutable Case.
- [x] Replay only the bounded no-secret standard HTTP contract through the
      existing Engine; fail closed for unsupported endpoints.
- [x] Compare two compatible terminal Explore Runs as exact evidence, never as
      a fabricated release decision.
- [x] Pass deterministic XiaoBaOS-compatible HTTP fixture browser acceptance,
      focused tests, type checks, production client build, and diff checks.

### Endpoint-push closure

- [x] Double-write secret-redacted Runtime-native OTLP to local evidence and
      the authenticated Platform project.
- [x] Use one Trace ID across edge Run creation, Events, summary telemetry, and
      terminal evaluation facts.
- [x] Make a completed endpoint Explore immediately eligible for Platform
      Inspector/Evolution/Reviewer, Case promotion, Replay, and Release Gate.
- [x] Prove auth isolation, redaction, failure semantics, and the full loop in
      the six-container acceptance environment.

### Complexity budget

- Reuse Scenario execution, HTTP Agent configuration, live Run drawer, Trace
  views, Evolution page, Go state machine, `AgentRuntimeAdapter`, Node worker,
  and Engine verifier.
- Add one narrowly allowlisted XiaoBaOS evaluator/evolution Runtime and one
  internal `spiral-runner` service for the Compose execution boundary; add no
  general target hosting, private tunnel, second Trace store, universal
  scheduler, or user/community portal.
- Keep Compare read-only; only Release Check emits release status.

### Dispatch ledger

| Child goal | Scope | Lifecycle | Decision |
| --- | --- | --- | --- |
| `platform_product_map` | product journey and information architecture | complete | adopted |
| `scenario_runtime_map` | existing Scenario HTTP execution/Trace seams | complete | adopted |
| `barena_integration_map` | Go adoption and Engine Replay seams | complete | adopted |

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
- [x] Add DeepSeek Harness as a public-headless Explore target while keeping
      all evaluator Roles on XiaoBaOS.
- [x] Validate and install an optional Catena `dsh_plugin` only into a
      run-private DSH Profile, with bridge telemetry and native session refs.
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
- [x] Merge the attributed scripted Simulation lane onto the canonical
      `AgentRuntimeAdapter`, preserving one session and exporting correlated
      Run/Turn/Check spans to Catena without adding a second Runtime seam.

### Verified

- [x] TypeScript build and focused ordinary-chat tests pass.
- [x] Complete repository suite passes: 178 tests, 0 failures, 0 skips.
- [x] Go control-plane race suite passes: exact event idempotency, real HTTP
      Run lifecycle, SSE reconnection, cancellation, and server-side package
      tamper rejection.
- [x] The NDJSON Worker executes the real deterministic XiaoBaOS four-actor
      Explore path and retains 7 native OTLP spans in a verified Run Package.
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
- [x] Real XiaoBaOS Simulation run `agent-simulation-20260812083633-995bb1`
      passed two turns and both checks; Catena retained Trace
      `0c133a14cdd90f81d39c488b85f78aae` with nine correlated spans.
- [x] Real official DeepSeek Harness `0.1.0-rc.7` Explore passed through the
      unchanged XiaoBaOS evaluator DAG and synchronized four native OTLP
      envelopes, seven local spans, one Barena summary Trace and one immutable
      13-event Run Bundle to Catena. Catena retained the result under a bound
      DSH Agent as one Session, one Trace and 20 correlated spans.
- [x] A second DSH Explore synchronized a 26-Span Trace into Catena; Trace Farm
      froze four DSH Traces and produced a strict two-file Plugin. DSH
      `0.1.0-rc.7` installed that generated package with `--ignore-scripts`,
      and `--dump-config` exposed the intended `system-prompt/config.persona`
      override. The complete Barena suite passes with 203 tests.
- [x] Final diff passes whitespace checks and the public-route boundary test proves no Arena runner import.
- [x] Public SkillsBench evidence integrity passes: selection SHA and poster
      validation ID match; 144 terminal rollouts, 90 verifier-admitted results,
      and 36 strict matched pairs reproduce the published summary.
- [x] Platform HTTP Explore acceptance completed one browser-native Scenario
      Run with a target-exported XiaoBaOS child span, adopted it without
      re-running or re-judging, promoted one immutable Case, replayed the safe
      HTTP contract, and produced a `cleared` Release Gate. Compatible Explore
      Runs are also available in the factual, read-only Compare view.
- [x] Persist project-scoped Evolution Jobs with ordered InspectorCat ->
      EvolutionCat -> ReviewerCat stages and expose Finding, Case proposal,
      draft Candidate, and proposal-only Review in the bilingual Barena UI.
- [x] Move the Compose execution path behind the functional internal
      `spiral-runner`, retain the local subprocess path only for compatibility,
      and pass the exact six-container health/protocol smoke.
- [x] Run a real browser journey from retained OTLP Trace through Evolution,
      deterministic Case Replay, Evaluation, replay Trace, and a persisted
      `cleared` Release Gate.

### Next product slices

- [x] Review and approve `docs/PLATFORM_PRD.md`, then synchronize the locked
      framework architecture before implementing the v0.2 local Web/Go
      platform vertical slice.
- [x] Introduce one internal Node Runner contract
      (`barena.engine_request.v1` / `barena.engine_event.v1` /
      `barena.run_package.v1`) with Server-assigned Run IDs, durable progress,
      cancellation, and relative evidence manifests before adding Web code.
- [x] Add the first Go control-plane slice with PostgreSQL Run/Event storage,
      Node Worker lifecycle, ordered SSE replay, cancellation, restart
      interruption, and server-side Run Package verification.
- [x] Add the P0 local Web surface with Runs, a natural-language XiaoBaOS
      Explore composer, live actor timeline, responsive Run Detail, and cancel.
- [x] Replace the functional Web shell with a three-pane evaluation workbench
      that separates conversation, Inspector/Reviewer judgment, OTel evidence,
      and raw Engine Events while keeping the current stage visible.
- [x] Replace the hand-written Web presentation with an embedded
      React/Vite/Chakra build and adapt Apache-2.0 LangWatch Scenario status,
      conversation, collapsible detail, and result-console components to
      Barena REST/SSE contracts with pinned-source attribution.
- [x] Complete a browser-level deterministic XiaoBaOS acceptance through
      Web/API → Go/PostgreSQL → Node Worker → TypeScript Explore, retaining
      1 Run and 19 ordered Engine Events without a paid model call.
- [ ] Run and retain the same Server-to-Engine acceptance against a
      non-fixture local XiaoBaOS Role before calling the v0.2 vertical slice
      production-ready.
- [x] Add GitHub identity, opaque server sessions, and owner-scoped Run access
      while preserving unauthenticated loopback local mode.
- [x] Add one-time personal API Tokens, edge Run creation, ordered Event
      ingestion, explicit completion, revocation, and Runner environment
      integration.
- [x] Distinguish local compatibility Runs from endpoint Runs and render both
      through one History/Trace evidence experience.
- [x] Refocus Web navigation on Explore, Traces, History, and Settings while
      retaining Replay/Compare as secondary CLI workflows.
- [x] Derive XiaoBa capability summaries from retained evaluation evidence and
      publish only user-reviewed aggregate profiles, never raw Trace evidence.
- [x] Decide and synchronize the Release Check policies:
      `non_regression` over one candidate Replay RunSet and `improvement` over
      compatible baseline/candidate RunSets.
- [x] Introduce the canonical `AgentRuntimeAdapter` lifecycle (`probe/openSession/sendTurn/cancel/close`) for XiaoBaOS Explore and keep `TargetAdapter.execute(...)` as a temporary Replay compatibility facade.
- [x] Export Barena-owned Replay/evaluator and HTTP boundary spans through
      signed OTLP, propagate real W3C parent context, and join both isolated
      attempts plus XiaoBaOS-native child spans into one Trace.
- [ ] Extend the same parent propagation acceptance to non-HTTP Runtime
      adapters where their native surfaces expose W3C Trace Context.
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
- [x] Let a terminal Platform Explore Run be explicitly retained as evidence,
      reviewed as an Issue, and promoted by a human into an immutable Replay
      Case without automatic release mutation.
- [ ] Validate real OpenClaw and Hermes installations beyond deterministic contract fixtures.
- [x] Publish the existing 24-task SkillsBench-derived method validation while
      preserving provenance, evidence exclusions, and non-official labeling.
- [x] Audit LangWatch's current licensing, select the Apache-2.0 community
      boundary, and create the
      `fightheyyy/barena-platform` downstream fork.
- [x] Prove the selected platform with a real OTLP/JSON Barena Explore trace:
      HTTP 200, zero rejected spans, Trace search, XiaoBaOS/model metadata,
      tool/artifact events, and the five-span actor waterfall.
- [x] Replay eight retained native XiaoBaOS OTLP/protobuf envelopes into the
      platform with zero rejection and recover four original
      `xiaoba.session` traces.
- [x] Apply the first isolated downstream patch for the Barena title, wordmark,
      Explore naming, onboarding copy, product boundary, and upstream policy.
- [x] Freeze the final source-of-truth boundary: TypeScript owns evaluation,
      the fork owns identity/Trace, and Go owns Run lifecycle plus immutable
      evaluation records without recomputing verdicts.
- [x] Reframe the Platform as a Runtime-agnostic continuous-evolution flywheel:
      real Sessions and Explore findings become reviewed Cases, Replay
      protects them, and Release records close the loop.
- [x] Implement the first Go Trace-to-Case slice with evidence-backed Issues,
      source Trace correlation, owner isolation, idempotent promotion, and one
      immutable Case revision across memory and PostgreSQL stores.
- [x] Verify the Trace-to-Case slice with HTTP integration, a real PostgreSQL
      17 transaction test, Go race tests and `go vet`; rebuild the TypeScript
      Engine and pass all 166 repository tests.
- [x] Implement the fork-side authenticated workflow gateway with timestamped
      HMAC body binding and signed project context for internal Go Run Control.
- [ ] Use one fork-issued project API key for both Run gateway and OTLP setup;
      remove the second Go endpoint credential after migration acceptance.
- [x] Add Go Run Package checksum validation, Case promotion state, persisted
      decision records, and Run-to-Trace correlation without adding Judge or
      Release Check logic.
- [x] Add the Barena Release Workbench to the fork, joining Trace evidence from
      the platform with Run, Case, scorecard, and decision state from Go.
- [x] Scope fork-originated Go workflow records to the signed Platform project
      principal rather than a browser-supplied owner header.
- [ ] Remove the legacy Go OAuth/custom React compatibility surface after
      endpoint-push parity; it is no longer the Platform identity boundary.
- [ ] Retire the Go-managed Node worker after endpoint-push execution,
      cooperative cancellation, and Workbench parity pass acceptance; do not
      add cloud scheduling, job leases, or a Go Runner in v0.3.

## Evidence rules

- Target completion never bypasses Barena's verifier.
- Boundary evidence must not be relabeled as native evidence.
- Native trace references are accepted only when ordinary target execution genuinely emits them.
- Fixed Replay marks UserCat/Inspector/Reviewer `not_applicable` until those stages actually run.
- `policy_only` never means a hard OS sandbox.
- Missing prerequisites yield held/blocked results rather than fallback or simulated success.

## Historical compatibility

Legacy XiaobaOS Arena result types remain for read-only run catalog/TUI inspection and source-level migration tests. The old executable runner/input/live-policy modules are excluded from the production build and public package exports. They should move under a dedicated test fixture or migration package after historical persisted runs no longer require compatibility work.
