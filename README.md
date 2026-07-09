<div align="center">

# Barena

### Agent capability customs for skills, roles, tools, prompts, and runtime changes

[![Barena](https://img.shields.io/badge/Barena-v0.1.0-6B7280.svg?labelColor=111827)](https://github.com/fightheyyy/barena)
[![Node](https://img.shields.io/badge/Node.js-18+-6B7280.svg?labelColor=339933)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-CLI-6B7280.svg?labelColor=3178C6)](https://www.typescriptlang.org/)
[![Runtime](https://img.shields.io/badge/runtime-deterministic-6B7280.svg?labelColor=7C3AED)](#current-runtime-boundary)
[![License](https://img.shields.io/badge/License-Apache--2.0-6B7280.svg?labelColor=16A34A)](#license)

**Agents can grow. Growth should be reviewable.**

[Why](#why) · [Core Loop](#core-loop) · [What Barena Clears](#what-barena-clears) · [Quick Start](#quick-start) · [Boundaries](#boundaries)

</div>

---

> What if every new agent capability had to pass customs before it became trusted?

Barena is a local CI system for agent capabilities. Before a skill, role, tool, prompt, runtime change, or agent target becomes trusted, Barena imports it as a subject, scans it, runs it in a clean workspace when allowed, records evidence, replays attempts, and emits a scorecard.

Barena does not accept "I finished" as proof. It asks for traces, artifacts, replay evidence, verifier output, issues, and a decision: `cleared`, `held`, or `rejected`.

---

## Why

Agent systems increasingly gain new skills, tools, roles, memory behaviors, runtime adapters, and automation paths. The risky part is not only whether an agent can complete one task. The risky part is deciding when a new capability is safe enough to reuse.

Barena turns that trust decision into an evidence trail.

| Trust question | Barena evidence |
|---|---|
| What changed? | Subject manifest, source path, fingerprint |
| Is it safe enough to run? | Static scan findings |
| What happened during execution? | Trace events and artifacts |
| Can it repeat the behavior? | Replay attempts |
| Did an external check pass? | Optional verifier result |
| Should it be trusted? | Scorecard decision |

---

## Core Loop

```text
new capability
  -> import as subject
  -> static scan
  -> clean run
  -> trace + artifacts
  -> replay attempts
  -> optional verifier
  -> reviewer scorecard
  -> cleared | held | rejected
```

This makes Barena closer to a capability admission gate than a benchmark leaderboard. The point is not one pretty score. The point is whether an agent capability can cross the trust boundary with evidence attached.

---

## What Barena Clears

| Subject | Status | Notes |
|---|---:|---|
| Local `SKILL.md` directory | Supported | Import, scan, run, replay, report |
| GitHub skill repository | Supported | Clone-and-scan only; no install scripts |
| Built-in agent target profile | Supported | `opencode`, `xiaoba`, `hermes`, `openclaw` |
| `role + skill` bundle | Planned | Targeted after skill-only MVP1 stabilizes |
| Real runtime adapter | Planned | XiaoBa AgentSession bridge is not invoked yet |

---

## MVP1

Barena MVP1 is a TypeScript CLI/TUI product for local capability clearance.

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

It does **not** invoke XiaoBa-CLI or `AgentSession` by default. A future adapter may call XiaoBa Arena or AgentSession when explicitly configured.

---

## Boundaries

Barena is not:

- A complete malware detector.
- A hosted benchmark leaderboard.
- An automatic production promotion system.
- A replacement for tests, code review, or runtime sandboxing.

Barena is a local admission gate for making agent growth inspectable.

This repository deliberately does not copy XiaoBa product surfaces such as Dashboard, Electron, Pet, Feishu, Weixin, output logs, or secrets. The runtime integration point is `src/adapters/xiaoba`.

## License

Apache-2.0.
