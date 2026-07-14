<div align="center">

<img src="assets/hero.gif" alt="Barena — end-to-end testing and release CI for AI agents." width="100%" />

# Barena

### End-to-end testing and release CI for AI agents

[![Barena](https://img.shields.io/badge/Barena-v0.1.0-6B7280.svg?labelColor=111827)](https://github.com/fightheyyy/barena)
[![Agent E2E](https://img.shields.io/badge/AI_Agent-E2E_Testing-D4A72C.svg?labelColor=111827)](#coming-soon-real-agent-e2e-testing)
[![Coming Soon](https://img.shields.io/badge/real_runtime-coming_soon-F59E0B.svg?labelColor=111827)](#coming-soon-real-agent-e2e-testing)
[![Node](https://img.shields.io/badge/Node.js-18+-6B7280.svg?labelColor=339933)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-CLI-6B7280.svg?labelColor=3178C6)](https://www.typescriptlang.org/)
[![Runtime](https://img.shields.io/badge/runtime-deterministic-6B7280.svg?labelColor=7C3AED)](#current-runtime-boundary)
[![License](https://img.shields.io/badge/License-Apache--2.0-6B7280.svg?labelColor=16A34A)](#license)

**When code becomes a black box, behavior becomes the contract. Barena tests the contract.**

[Why Agent E2E](#why-agent-e2e-testing) · [How It Works](#how-it-works) · [Coming Soon](#coming-soon-real-agent-e2e-testing) · [Quick Start](#quick-start) · [Boundaries](#boundaries)

</div>

---

> What if every agent release had to prove it could still complete real user tasks?

Barena is an open-source end-to-end testing and release CI project for AI agents. It treats the agent system — model, prompt, skills, tools, memory, and runtime — as a black box, then evaluates observable behavior with clean runs, traces, artifacts, replay evidence, verifiers, and release decisions.

The current MVP provides deterministic local capability clearance for skills and agent target profiles. **Real-runtime, task-level Agent E2E testing is coming soon.**

---

## Why Agent E2E Testing

An AI agent's behavior is no longer defined by code alone. It emerges from model decisions, prompts, skills, tool calls, memory, permissions, environment state, and external services. Reading the implementation cannot prove that the system will finish the user's job correctly.

Every model swap, prompt edit, new skill, or tool change can introduce a silent regression. Barena moves trust from implementation inspection to end-to-end behavioral evidence.

| Release question | Barena evidence |
|---|---|
| What agent capability changed? | Subject manifest, source path, fingerprint |
| Is it safe enough to run? | Static scan findings |
| What happened end to end? | Trace events and artifacts |
| Did it produce the correct outcome? | Verifier result |
| Is the behavior stable? | Replay attempts |
| Should this release be trusted? | `cleared`, `held`, or `rejected` |

---

## How It Works

```text
agent release candidate
  -> import as subject
  -> static scan
  -> clean run
  -> trace + artifacts
  -> replay attempts
  -> optional verifier
  -> reviewer scorecard
  -> cleared | held | rejected
```

Barena is a release gate, not a benchmark leaderboard. The goal is not one impressive score; it is repeatable proof that an agent capability can cross a trust boundary without breaking expected behavior.

---

## Coming Soon: Real Agent E2E Testing

Barena is evolving from deterministic capability clearance into a real-runtime E2E testing layer for AI agents.

- Run real multi-turn tasks against XiaoBa, OpenCode, Hermes Agent, and OpenClaw.
- Define reusable E2E cases with task prompts, fixtures, permissions, and assertions.
- Verify final state across files, Git repositories, browser sessions, artifacts, and allowed side effects.
- Replay cases to detect flaky agent behavior.
- Compare releases to surface capability regressions after model, prompt, skill, or tool changes.
- Gate agent releases in CI with evidence-backed pass, hold, or reject decisions.

The first real runtime target is the XiaoBa `AgentSession` bridge. Until that lands, the runtime badge and generated scorecards explicitly report the deterministic adapter boundary.

---

## What Barena Clears

| Subject | Status | Notes |
|---|---:|---|
| Local `SKILL.md` directory | Supported | Import, scan, run, replay, report |
| GitHub skill repository | Supported | Clone-and-scan only; no install scripts |
| Built-in agent target profile | Supported | `opencode`, `xiaoba`, `hermes`, `openclaw` |
| `role + skill` bundle | Coming soon | Targeted after skill-only MVP1 stabilizes |
| Real runtime E2E adapter | Coming soon | XiaoBa AgentSession bridge is not invoked yet |
| Reusable E2E case format | Coming soon | Task, fixtures, permissions, and state assertions |
| Cross-version regression report | Coming soon | Compare pass, fail, and flaky behavior between releases |

---

## MVP1

Barena MVP1 is a TypeScript CLI/TUI foundation for local capability clearance and the future Agent E2E runner.

| Area | Capability |
|---|---|
| Import | Local skills, GitHub skill repositories, built-in agent targets |
| Safety | Static scan before runtime execution |
| Runtime | Clean run directories under `runs/<run-id>/` |
| Review | UserCat, InspectorCat, ReviewerCat contracts |
| Stability | Replay attempts with trace refs |
| Verification | Optional verifier command |
| Output | JSON scorecards and Markdown reports |
| Decisions | `cleared`, `held`, `rejected` |
| Statuses | `pass`, `unstable`, `reopened`, `blocked`, `unsafe` |
| UI | Terminal-native black/gold TUI |

---

## Quick Start

Install and build:

```bash
npm install
npm run check
```

Use the local CLI:

```bash
BAR="node dist/index.js"
```

Clear a local skill:

```bash
$BAR import skill test/fixtures/skills/good-skill --id good-skill
$BAR scan good-skill
$BAR run good-skill --replays 3 --verifier test/fixtures/verifiers/pass.js
$BAR scorecard <run-id>
$BAR report <run-id> --format markdown
```

Preview the terminal dashboard:

```bash
$BAR tui
```

Import a GitHub skill repository for clone-and-scan review:

```bash
$BAR import github owner/repo --id candidate-skill --ref main
```

GitHub import clones and scans only. It does not run install scripts or arbitrary repository code.

---

## Built-In Agent Targets

```bash
$BAR list targets
$BAR import agent opencode --id opencode-ci
$BAR run opencode-ci --replays 1
```

| Target | Focus |
|---|---|
| `opencode` | Coding agent and code-task CI |
| `xiaoba` | Dogfood runtime for governable skill and role growth |
| `hermes` | Growth and self-improving agent CI |
| `openclaw` | Local assistant permissions, channels, and side effects |

---

## Commands

```text
barena import skill <path>
barena import github <owner/repo|url>
barena import agent <opencode|xiaoba|hermes|openclaw>
barena scan <subject-id>
barena run <subject-id> [--replays 3] [--verifier path]
barena scorecard <run-id>
barena report <run-id> [--format markdown|json]
barena list subjects
barena list runs
barena list targets
barena tui [--snapshot] [--color|--no-color]
barena doctor
```

---

## Run Package

```text
runs/<run-id>/
  run-manifest.json
  workspace/
  scan/scan-report.json
  traces/trace.ndjson
  artifacts/
  inspector/issues.json
  replays/replay-*/trace.ndjson
  verifier/verifier-results.json
  reviewer/scorecard.json
  reports/report.json
  reports/report.md
```

---

## Barena As A Skill

Barena can also be packaged as an agent-facing clearance skill. In that form, the skill teaches an agent when to invoke Barena, how to interpret scorecards, and when to refuse self-promotion. The CLI remains the evidence engine.

The intended behavior is:

```text
skill / role / tool / prompt / runtime change
  -> Barena clearance
  -> trusted only when evidence says cleared/pass
```

---

## Current Runtime Boundary

MVP1 uses a deterministic XiaoBa-compatible adapter boundary:

```text
provider: barena-deterministic
adapter: xiaoba-compatible
xiaoba_invoked: false
```

It does **not** invoke XiaoBa-CLI or `AgentSession` by default. The real-runtime E2E adapter is **coming soon** and will remain explicitly opt-in.

---

## Boundaries

Barena is not:

- A complete malware detector.
- A hosted benchmark leaderboard.
- An automatic production promotion system.
- A replacement for unit tests, code review, or runtime sandboxing.

Barena adds the end-to-end behavioral tests that agent releases increasingly depend on.

This repository deliberately does not copy XiaoBa product surfaces such as Dashboard, Electron, Pet, Feishu, Weixin, output logs, or secrets. The runtime integration point is `src/adapters/xiaoba`.

## License

Apache-2.0.
