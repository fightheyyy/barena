# Barena

**Agent capability customs.**

Barena is a local CI system for agent capabilities. Before a skill, role, tool, prompt, runtime change, or agent target becomes trusted, Barena imports it as a subject, scans it, runs it in a clean workspace when allowed, records evidence, replays attempts, and emits a scorecard.

The goal is simple: agents can grow, but growth should be reviewable.

## Why

Agent systems increasingly gain new skills, tools, roles, memory behaviors, runtime adapters, and automation paths. The risky part is not only whether an agent can complete one task. The risky part is deciding when a new capability is safe enough to reuse.

Barena turns that trust decision into an evidence trail:

- What changed?
- Was it statically safe enough to run?
- Did it leave artifacts?
- Did it behave consistently on replay?
- Did an optional verifier pass?
- Should it be `cleared`, `held`, or `rejected`?

Barena does not accept "I finished" as proof. It asks for traces, artifacts, replay evidence, verifier output, issues, and a scorecard.

## MVP1

Barena MVP1 is a TypeScript CLI/TUI product for local capability clearance.

It currently supports:

- Local skill import from a `SKILL.md` directory.
- GitHub skill import for clone-and-scan review.
- Built-in agent CI target profiles for `opencode`, `xiaoba`, `hermes`, and `openclaw`.
- Static scan before runtime execution.
- Clean run directories under `runs/<run-id>/`.
- Deterministic UserCat, InspectorCat, and ReviewerCat contracts.
- Replay attempts.
- Optional verifier execution.
- JSON and Markdown reports.
- Scorecard decisions: `cleared`, `held`, `rejected`.
- Review statuses: `pass`, `unstable`, `reopened`, `blocked`, `unsafe`.
- A terminal-native black/gold TUI.

## Current Runtime Boundary

MVP1 uses a deterministic XiaoBa-compatible adapter boundary:

```text
provider: barena-deterministic
adapter: xiaoba-compatible
xiaoba_invoked: false
```

It does **not** invoke XiaoBa-CLI or `AgentSession` by default. A future adapter may call XiaoBa Arena or AgentSession when explicitly configured.

## Install

```bash
npm install
npm run check
```

For local development:

```bash
npm run dev -- --help
```

After build:

```bash
node dist/index.js --help
```

## Quick Start

Import and clear a local skill:

```bash
node dist/index.js import skill test/fixtures/skills/good-skill --id good-skill
node dist/index.js scan good-skill
node dist/index.js run good-skill --replays 3 --verifier test/fixtures/verifiers/pass.js
node dist/index.js scorecard <run-id>
node dist/index.js report <run-id> --format markdown
node dist/index.js tui
```

Import a GitHub skill repository for clone-and-scan review:

```bash
node dist/index.js import github owner/repo --id candidate-skill --ref main
```

GitHub import clones and scans only. It does not run install scripts or arbitrary repository code.

Import and run a built-in agent target:

```bash
node dist/index.js list targets
node dist/index.js import agent opencode --id opencode-ci
node dist/index.js run opencode-ci --replays 1
```

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

## Barena As A Skill

Barena can also be used as an agent-facing clearance skill. In that form, the skill teaches an agent when to invoke Barena, how to interpret scorecards, and when to refuse self-promotion. The CLI remains the evidence engine.

The intended behavior is:

```text
new capability -> import -> scan -> clean run -> replay -> verifier -> scorecard -> cleared | held | rejected
```

## Release Checks

```bash
npm run check
npm run pack:dry-run
```

## Safety Boundary

Barena is not a complete malware detector, not a hosted benchmark leaderboard, and not an automatic production promotion system. It is a local admission gate for making agent growth inspectable.

This repository deliberately does not copy XiaoBa product surfaces such as Dashboard, Electron, Pet, Feishu, Weixin, output logs, or secrets. The runtime integration point is `src/adapters/xiaoba`.
