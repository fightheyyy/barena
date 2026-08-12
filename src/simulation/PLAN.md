# Agent Simulation Module PLAN

## Current Status

The first XiaoBaOS simulation slice is implemented and live-validated against
Catena. The Runner uses the canonical `AgentRuntimeAdapter`; no parallel
connector abstraction was added.

## Milestones

- [x] Define and validate `barena.agent_simulation_case.v1`.
- [x] Preserve one Runtime session across scripted turns.
- [x] Persist boundary evidence and deterministic scorecards.
- [x] Add `barena simulation run` and the package export.
- [x] Export Run, Turn, and Check spans through OTLP/HTTP.
- [x] Propagate each `barena.turn` as the Runtime W3C parent.
- [x] Keep the Run root free of synthetic user input.
- [ ] Add live Codex, Claude Code, and OpenClaw adapters only after their
      canonical `AgentRuntimeAdapter` implementations exist.
- [ ] Add optional semantic Judge evidence without weakening deterministic
      assertions.

## Owners

- Barena owns orchestration, boundary evidence, assertions, and scorecard.
- Runtime Adapter owns session and native telemetry behavior.
- Catena owns durable Trace observation.

## Acceptance Criteria

- Unit tests prove one-session multi-turn behavior and OTLP ancestry.
- Live XiaoBaOS run retains requested model and native child spans in Catena.
- No API key or endpoint is persisted in the scorecard.
- `npm run check` and `npm run pack:dry-run` pass.

## Verification Log

- 2026-08-12: live Run `agent-simulation-20260812083633-995bb1` passed two
  turns and both deterministic checks. Catena retained Trace
  `0c133a14cdd90f81d39c488b85f78aae` with nine Spans and requested model
  `gpt-5.6-sol`.

## Risks / Open Questions

- Scripted cases validate conversation behavior, not autonomous UserCat parity.
- Deterministic text checks are weaker than semantic judgment by design.
- Catena is authoritative for retained native Runtime spans.

## Status Maintenance Rules

Record only verification commands and live Runs that actually pass.
