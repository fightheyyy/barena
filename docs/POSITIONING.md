# Barena Positioning Contract

Status: **Locked**  
Version: **1.1**  
Locked on: **2026-07-14**  
Tactical amendment: **2026-07-14 — XiaoBa-first native runtime evidence**  
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

## Phase 1 Wedge: XiaoBa Role and Skill Release CI

The product category remains Agent E2E release CI. Phase 1 deliberately starts with the two native XiaoBa capability artifacts that can be exercised through the existing Arena contract:

> Validate whether adding or updating a XiaoBa Role or Skill makes the target runtime measurably better and reliably so, without introducing regressions.

Phase 1 is fixed as follows:

| Concern | Phase 1 decision |
|---|---|
| Change type | XiaoBa Role or Skill introduction/version update |
| Target runtime | XiaoBa-CLI first native target; OpenClaw first external target |
| Comparison | Skill: same explicit Role without vs with candidate Skill; Role: explicit baseline Role vs candidate Role |
| Case source | XiaoBa native Arena suites/cases first; SkillsBench-derived external calibration next |
| Evaluator runtime | XiaoBa-CLI only |
| Evaluator roles | UserCat, InspectorCat, ReviewerCat |
| Evidence | XiaoBa native trace/scorecard plus artifacts, verifier, and replay; Barena boundary trace for external targets |
| Decision | `cleared`, `held`, or `rejected` |

The complete Phase 1 evaluation requires all three evaluator Agents to run through XiaoBa-CLI. A deterministic TypeScript fallback is not equivalent and must never be reported as a real three-Agent evaluation. XiaoBa native Arena may orchestrate evaluator and target planes within one CLI execution; Barena must keep their evidence identities logically distinct and must not claim separate OS processes unless observed.

The current XiaoBa 0.1.1 native Arena implements UserCat planning, Inspector analysis, and Reviewer classification as XiaoBa-owned pipeline stages; only the target execution produces native `AgentSession` traces. Barena may use those stages for native runtime calibration, but every result must record `three_evaluator_agent_sessions=false` and must not describe the current path as three independent evaluator AgentSessions.

The tactical amendment is evidence-driven and does not change the product category. XiaoBa 0.1.1 already exposes native `base_skill`, `role`, and `role_skill` Arena subjects with clean runtime, evaluator roles, replay, native traces, and scorecards, while the OpenClaw three-evaluator path remains blocked on an external-target seam. Therefore XiaoBa becomes the first native vertical slice and OpenClaw remains the first portability proof through an external `TargetAdapter`.

XiaoBa currently has no subject-free `base` Arena mode. Barena must therefore require an explicit truthful baseline: a Role-only run for same-Role Skill evaluation, a previous Skill/Role version where available, or an explicit baseline Role for Role evaluation. It must return `held/blocked` when the requested baseline cannot be represented; it must never manufacture a no-op subject.

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

- **Evaluator runtime:** XiaoBa-CLI runs UserCat, InspectorCat, and ReviewerCat.
- **First native target runtime:** XiaoBa-CLI native Arena evaluates XiaoBa Roles and Skills through its composite evaluation contract.
- **First external target runtime:** OpenClaw remains the first `TargetAdapter` portability target; other open-source Agents arrive through the same external boundary.
- **Barena:** owns orchestration, case identity, boundary observations, replay, verification, evidence coverage, and release artifacts.
- **Target-native trace:** first-class when XiaoBa Arena actually emits it; optional for external targets and never inferred or fabricated.

Missing evaluator support, target binaries, credentials, configuration, or evidence must produce `blocked`/`held`, not simulated success.

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
- a replacement for XiaoBa-CLI;
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

1. Publish a transparent XiaoBa Role/Skill calibration using the implemented native paired evaluation path.
2. Add the XiaoBa external-target driver seam for three real evaluator AgentSessions.
3. Import a small deterministic SkillsBench calibration set and run OpenClaw Skill comparisons.
4. Put the same release decision into GitHub CI.
5. Expand to prompts, models, tools, memory, and runtime changes.
6. Add other open-source target runtimes only after the first loop is credible.

Feature filter:

> Does this help an open-source Agent maintainer decide whether a behavioral change can ship?

If the answer is not clearly yes, defer it during Phase 1.

## Approved Public Language

Use:

- `End-to-end testing and release CI for open-source AI agents.`
- `Prove every Agent change works reliably before you ship it.`
- `Starting with XiaoBa Roles and Skills: validate effectiveness, stability, and regressions in the native runtime.`

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
- implementation evidence showing the XiaoBa evaluator contract is infeasible;
- implementation evidence showing a native XiaoBa Role/Skill loop is executable before the external-target seam;
- actual user adoption converging on a materially different job.

Any positioning change must update this file first, explain the evidence, and then synchronize README, SPEC, PLAN, and GitHub metadata.
