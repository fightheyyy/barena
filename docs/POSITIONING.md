# Barena Positioning Contract

Status: **Locked**
Version: **1.4**
Locked on: **2026-07-14**
Tactical amendments: **2026-07-14 — XiaobaOS-first evidence; 2026-07-19 — portable verifier profile; 2026-07-22 — evaluator/target separation: Barena must not invoke XiaobaOS Arena; 2026-07-27 — Replay/Explore/Compare, AgentRuntimeAdapter, and OTel/OTLP architecture**
Review on or after: **2026-10-14**

This is the authoritative product-positioning document for Barena. README, SPEC, PLAN, roadmap, GitHub copy, and implementation priorities must remain consistent with it. If another document conflicts with this file, this file wins.

## Canonical Positioning

> **Barena is Agentic Eval and Release for Agent Harness Evolution.**

> **Barena 是面向 Agent Harness 演进的 Agentic Eval 与发布框架。**

Supporting promise:

> **Prove every Agent change works reliably before you ship it.**

Barena does not answer which Agent is smartest. It answers whether a specific Agent change is effective, stable, regression-free, and ready to ship.

## Problem

An Agent's behavior emerges from its model, prompt, skills, tools, memory, permissions, environment, and runtime. Code review alone cannot prove that a changed Agent will still complete real user tasks.

Maintainers need release evidence after a behavioral change:

- Does the target runtime still produce the required outcome?
- Did the change measurably help?
- Is the result repeatable across replays?
- Did the change introduce regressions, unsafe behavior, or excessive cost?
- Is there enough evidence to release the candidate?

## Customer and Release Moment

Initial customer:

- Maintainers of open-source AI Agents and Agent Skills.
- Teams integrating Skills into an open-source Agent runtime.

Primary trigger:

- A Skill, prompt, model, tool, memory policy, permission, or runtime change is about to be merged or released.

Core job to be done:

> Decide whether this Agent change can ship, based on reproducible end-to-end evidence.

## Product Contract

Barena evaluates a release candidate, not an abstract model score:

```text
Barena(
  target runtime,
  baseline configuration,
  candidate configuration,
  E2E case pack,
  replay policy
)
  -> effectiveness
  -> stability
  -> regressions
  -> evidence
  -> cleared | held | rejected
```

Required output:

- Baseline and candidate task-success rates.
- Candidate lift or regression relative to baseline.
- Replay stability and flaky behavior.
- Artifact and final-state verifier results.
- Barena-owned boundary traces and evidence provenance.
- Issues and suspected root causes.
- A release decision: `cleared`, `held`, or `rejected`.

## Framework Architecture

The technical architecture is fixed in [`ARCHITECTURE.md`](./ARCHITECTURE.md):

- `barena replay` protects known capabilities with fixed Cases.
- `barena explore` uses a simulated-user, Inspector, and Reviewer loop to discover unknown behavior boundaries.
- `barena compare` compares compatible baseline and candidate RunSets and feeds the release gate; it is not a third evaluator.
- Every tested Agent Runtime is reached through `AgentRuntimeAdapter`.
- OpenTelemetry is the canonical behavioral trace schema, OTLP is the canonical export/ingest protocol, and W3C Trace Context carries correlation.
- Barena-owned boundary spans are mandatory. Runtime-native spans are optional, accepted only when genuinely exported, and never inferred from prose.
- Artifact and deterministic verifier evidence remains first-class and is correlated with, not replaced by, OTel traces.

## Phase 1 Wedge: XiaobaOS Skill Release Evaluation

The product category remains Agentic Eval and Release for Agent Harness Evolution. Barena was extracted from the XiaobaOS Arena concept, so the independent product must own evaluation rather than call back into the embedded Arena. Phase 1 starts with XiaobaOS Skill changes through the ordinary Agent chat surface, then applies the same target-adapter boundary to OpenClaw, Hermes, and custom CLI agents:

> Validate whether adding or updating an Agent capability makes the target runtime measurably better and reliably so, without introducing regressions.

Phase 1 is fixed as follows:

| Concern | Phase 1 decision |
|---|---|
| Change type | XiaobaOS Skill introduction or version update first; prompt/model/tool/runtime changes through versioned target configurations later |
| Target runtime | XiaobaOS first built-in ordinary-chat target; OpenClaw built-in target; Hermes/custom CLI agents through the portable JSON driver |
| Comparison | Same explicit Role and task without versus with the candidate Skill |
| Case source | Barena cases, historical failures, and SkillsBench-derived calibration |
| Evaluation profile | Barena-owned case driving, replay, inspection, deterministic verification, and release aggregation across targets |
| Evaluator stages | Owned and recorded by Barena; a target runtime never supplies Barena's evaluator result |
| Evidence | Barena boundary/workspace/verifier evidence plus optional genuine target-native trace when the ordinary target run emits it |
| Decision | `cleared`, `held`, or `rejected` |

Barena must never invoke `xiaoba arena` to evaluate XiaobaOS. Doing so makes the supposedly independent evaluator depend on the subsystem from which it was extracted, mixes evaluator and target ownership, and prevents the same workflow from being applied consistently to other runtimes.

The target contract is deliberately narrow: start an isolated session/workspace, send a user message through the runtime's ordinary Agent surface, collect observable output/workspace changes and any genuine native trace, then close the session. Target-reported completion never bypasses Barena's verifier. Boundary-only evidence must remain visibly labeled and must not fabricate target-native tool calls or hidden reasoning.

For XiaobaOS, Barena invokes the ordinary `chat --role ... --message ... [--skill ...]` surface. XiaobaOS owns Role, Skill, Tool, model, memory, and session execution; Barena owns UserCat/case driving, inspection, replay, verification, aggregation, and the release decision. The first Explore implementation uses XiaoBaOS Roles for UserCat, InspectorCat, and ReviewerCat, but Barena owns their prompts, session isolation, evidence contract, parsing, and outcome semantics; XiaoBaOS Arena is never invoked.

This amendment is evidence-driven and does not change the product category. The previous Arena-coupled implementation proved integration mechanics but invalidated Barena's independence boundary. XiaobaOS already exposes an ordinary CLI chat surface, OpenClaw exposes a local JSON Agent surface, and Hermes/custom agents can conform through a small JSON driver; all belong behind `AgentRuntimeAdapter`.

Barena must require a truthful baseline. Initial XiaobaOS Skill evaluation holds the Role, model, task, fixture, and target configuration constant while varying only candidate Skill activation. Role comparison remains unavailable until both Role configurations can be executed through the same ordinary target contract; Barena must not fall back to Arena to preserve an old feature claim.

## Role of SkillsBench

SkillsBench is not Barena's product category and Barena is not a SkillsBench clone.

Barena reuses SkillsBench task packages as public, reproducible external evidence:

- task prompt;
- container environment and fixtures;
- curated Skill;
- Oracle;
- deterministic verifier.

Barena adds the release-CI layer:

- baseline/candidate comparison;
- repeated execution and flaky detection;
- boundary evidence;
- InspectorCat diagnosis;
- ReviewerCat release decision;
- regression reporting tied to concrete runtime and Skill versions.

Public wording should be `Barena evaluated on SkillsBench tasks` or `SkillsBench-derived Barena calibration`, never `official SkillsBench leaderboard result` unless the official harness and submission rules are followed.

## Runtime and Evidence Boundaries

- **Evaluation runtime:** Barena owns case/UserCat driving, Inspector/Reviewer logic, replay, verification, aggregation, and release decisions.
- **XiaobaOS target runtime:** invoked only through the ordinary chat surface; its embedded Arena is not a Barena dependency.
- **Other target runtimes:** Claude Code, Codex, and OpenClaw use built-in Runtime adapters; Hermes and other open-source CLI Agents use the portable CLI boundary until a native adapter is justified.
- **Barena:** owns case identity, boundary observations, evaluator evidence, replay, verification, evidence coverage, and release artifacts.
- **Target-native trace:** optional for every target and accepted only when the ordinary target execution genuinely emits it; never inferred or fabricated.

Missing native evaluator support, portable driver support, target binaries, credentials, configuration, or required evidence must produce `blocked`/`held`, not simulated success.

## Release Semantics

| Effectiveness | Stability / safety | Decision |
|---|---|---|
| Measurable improvement | Stable, no regression | `cleared` |
| Improvement | Flaky or evidence incomplete | `held` |
| No demonstrated benefit | Stable but unjustified change | `held` |
| Capability regression | Any | `rejected` |
| Unsafe behavior | Any | `rejected` |
| Runtime/evidence unavailable | Not executable | `held` with `blocked` status |

## What Barena Is Not

Barena is not:

- an Agent leaderboard;
- a generic benchmark platform;
- a Skill marketplace;
- a new Agent runtime;
- a replacement for XiaobaOS;
- primarily a malware scanner or security certification product;
- primarily a one-off audit-report publisher;
- a GUI automation framework;
- a hosted dashboard in Phase 1.

Public audits and benchmark reports are distribution and validation mechanisms. They are not the product itself. GUI or browser runtimes may become future target adapters only after the release-CI loop is proven.

## Success Metrics

North-star outcome:

> Confirmed Agent regressions caught before release.

Phase 1 quality metrics:

- False clear rate: verifier fails but Barena clears.
- Stable-pass recall: consistently passing candidates correctly cleared.
- Flaky detection rate.
- Skill lift and regression accuracy.
- InspectorCat root-cause usefulness.
- Evidence completeness and fabricated-evidence count.
- External repositories repeatedly running Barena before merge or release.

GitHub stars, report views, and benchmark run counts are secondary signals; they do not prove product value.

## Roadmap Guardrail

Near-term sequence:

1. Keep the removed XiaobaOS Arena dependency out of every public path.
2. Preserve the shipped SkillsBench-derived XiaobaOS Skill comparison through Barena-owned attempts and verifiers.
3. Extend the shipped multi-turn `AgentRuntimeAdapter` from XiaoBaOS Explore to Replay and additional Runtimes.
4. Calibrate the shipped bounded XiaoBaOS Explore campaign and reviewable Replay Case candidates on real Roles.
5. Add Barena-owned evaluator/boundary OTel spans; continue ingesting genuine Runtime-native OTLP without fabricating unsupported parentage.
6. Add Claude Code, Codex, OpenClaw, and portable/Hermes Explore behind the same Runtime registry and evaluator-owned workflow.
7. Ship the new `barena replay` and `barena compare` surfaces and put their release decision into GitHub CI.
8. Expand to Role, prompt, model, tool, memory, and runtime comparisons once truthful baseline/candidate target configurations exist.

Feature filter:

> Does this help an open-source Agent maintainer decide whether a behavioral change can ship?

If the answer is not clearly yes, defer it during Phase 1.

## Approved Public Language

Use:

- `Agentic Eval and Release for Agent Harness Evolution.`
- `Prove every Agent change works reliably before you ship it.`
- `Barena-owned evaluation across XiaobaOS, OpenClaw, Hermes, and custom CLI Agent targets.`

Avoid positioning Barena as:

- `the best Agent benchmark`;
- `an Agent leaderboard`;
- `a Skill evaluation website`;
- `an AI security auditor`;
- `a GUI Agent framework`.

## Change Control

This positioning is frozen until the review date. New ideas may change tactics, adapters, case sources, or distribution, but must not silently change the product category.

Before the review date, this contract may change only when concrete evidence invalidates it, such as:

- repeated maintainer interviews showing the release decision is not valuable;
- SkillsBench calibration showing the evaluation cannot be made reliable;
- implementation evidence showing the XiaobaOS evaluator contract is infeasible;
- implementation evidence showing a native XiaobaOS Role/Skill loop is executable before the external-target seam;
- actual user adoption converging on a materially different job.

Any positioning change must update this file first, explain the evidence, and then synchronize README, SPEC, PLAN, and GitHub metadata.
