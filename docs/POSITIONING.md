# Barena Positioning Contract

Status: **Locked**
Version: **1.2**
Locked on: **2026-07-14**
Tactical amendments: **2026-07-14 — XiaobaOS-first native runtime evidence; 2026-07-19 — portable verifier profile for external CLI agents**
Review on or after: **2026-10-14**

This is the authoritative product-positioning document for Barena. README, SPEC, PLAN, roadmap, GitHub copy, and implementation priorities must remain consistent with it. If another document conflicts with this file, this file wins.

## Canonical Positioning

> **Barena is end-to-end testing and release CI for open-source AI agents.**

> **Barena 是开源 AI Agent 的端到端测试与发布 CI。**

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

## Phase 1 Wedge: XiaobaOS Role and Skill Release CI

The product category remains Agent E2E release CI. Phase 1 deliberately starts with the two native XiaobaOS capability artifacts that can be exercised through the existing Arena contract, then exposes the same deterministic release gate to external CLI agents through a lower-evidence portable verifier profile:

> Validate whether adding or updating an Agent capability makes the target runtime measurably better and reliably so, without introducing regressions.

Phase 1 is fixed as follows:

| Concern | Phase 1 decision |
|---|---|
| Change type | XiaobaOS Role/Skill introduction or version update; external Agent behavior/configuration changes through portable cases |
| Target runtime | XiaobaOS first native target; OpenClaw first built-in portable target; Hermes/custom CLI agents through the portable JSON driver |
| Comparison | Skill: same explicit Role without vs with candidate Skill; Role: explicit baseline Role vs candidate Role |
| Case source | XiaobaOS native Arena suites/cases first; SkillsBench-derived calibration and portable E2E cases next |
| Evaluation profile | `xiaobaos_native` for native Arena; `portable_verifier` for external CLI agents |
| Evaluator stages | XiaobaOS native stages where emitted; `not_applicable` in portable verifier mode |
| Evidence | XiaobaOS native trace/scorecard plus artifacts, verifier, and replay; Barena boundary/workspace/verifier evidence for portable targets |
| Decision | `cleared`, `held`, or `rejected` |

The highest-evidence native profile runs through XiaobaOS Arena. A deterministic TypeScript fallback is not equivalent and must never be reported as a real three-Agent evaluation. XiaobaOS native Arena may orchestrate evaluator and target planes within one CLI execution; Barena must keep their evidence identities logically distinct and must not claim separate OS processes unless observed.

The portable verifier profile is a separate, honest release contract. It may clear deterministic artifact/final-state outcomes when the driver protocol, Barena boundary trace, workspace observation, verifier evidence, and all planned attempts are complete. It must report `evaluation_mode=portable_verifier`, `evidence_profile=boundary_verified`, `target_native_trace=false`, and `isolation=policy_only`; it must not fabricate UserCat, InspectorCat, ReviewerCat, target-native tool, or hidden-reasoning traces. Replay count alone never upgrades boundary-only evidence above medium confidence.

The supported XiaobaOS 0.1.1 and 0.2.0 native Arena contracts implement UserCat planning, Inspector analysis, and Reviewer classification as XiaobaOS-owned pipeline stages; only the target execution produces native `AgentSession` traces. Barena may use those stages for native runtime calibration, but every result must record `three_evaluator_agent_sessions=false` and must not describe the current path as three independent evaluator AgentSessions.

The tactical amendments are evidence-driven and do not change the product category. XiaobaOS exposes native `base_skill`, `role`, and `role_skill` Arena subjects with clean runtime, evaluator stages, replay, native traces, and scorecards. OpenClaw already exposes an executable local JSON CLI boundary, while Hermes and other CLI agents can conform through a small JSON driver. Therefore XiaobaOS remains the first and highest-evidence native vertical slice, and the portable verifier becomes the public cross-runtime path without waiting for a XiaobaOS external-evaluator seam.

XiaobaOS currently has no subject-free `base` Arena mode. Barena must therefore require an explicit truthful baseline: a Role-only run for same-Role Skill evaluation, a previous Skill/Role version where available, or an explicit baseline Role for Role evaluation. It must return `held/blocked` when the requested baseline cannot be represented; it must never manufacture a no-op subject.

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

- **Native evaluation runtime:** XiaobaOS runs its UserCat, InspectorCat, and ReviewerCat stages and evaluates XiaobaOS Roles and Skills through the composite Arena contract.
- **Portable evaluation runtime:** Barena runs the target driver, records boundary/workspace observations, executes deterministic verifiers, aggregates replay, and applies the release gate; evaluator stages are not applicable.
- **First external target runtime:** OpenClaw is the first built-in portable adapter; Hermes and other open-source CLI Agents arrive through the portable JSON driver boundary.
- **Barena:** owns orchestration, case identity, boundary observations, replay, verification, evidence coverage, and release artifacts.
- **Target-native trace:** first-class when XiaobaOS Arena actually emits it; optional for external targets and never inferred or fabricated.

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

1. Publish a transparent XiaobaOS Role/Skill calibration using the implemented native paired evaluation path.
2. Ship the portable verifier and JSON driver contract with installable OpenClaw and Hermes/custom examples.
3. Run a small deterministic SkillsBench-derived OpenClaw Skill comparison through the portable path.
4. Add the optional XiaobaOS external-target evaluator seam when it can produce stronger evidence than the portable profile.
5. Put the same release decision into GitHub CI.
6. Expand to prompts, models, tools, memory, and runtime changes.

Feature filter:

> Does this help an open-source Agent maintainer decide whether a behavioral change can ship?

If the answer is not clearly yes, defer it during Phase 1.

## Approved Public Language

Use:

- `End-to-end testing and release CI for open-source AI agents.`
- `Prove every Agent change works reliably before you ship it.`
- `Native XiaobaOS evaluation plus a portable deterministic verifier for OpenClaw, Hermes, and other CLI agents.`

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
