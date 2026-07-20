# Barena Clearance Skill Design

Status: Draft
Last updated: 2026-07-07

Barena can be packaged as an agent-facing skill without turning the skill itself into the clearance engine. The skill should teach an agent when to invoke Barena, how to run the clearance flow, how to interpret evidence, and when to refuse self-promotion. The Barena CLI remains the evidence engine.

## Product Shape

The product has two layers:

- Barena CLI/TUI: imports subjects, scans them, runs them in clean workspaces, records traces and artifacts, replays attempts, invokes optional verifiers, and emits scorecards.
- Barena clearance skill: gives agents a compact admission runbook for using Barena before trusting a new or changed capability.

The skill is not a replacement for tests, security review, or runtime sandboxing. It is a procedural gate that prevents an agent from treating its own confidence as evidence.

## Core Principle

Agents can propose growth, but they should not certify their own growth by assertion. A capability becomes trusted only after Barena produces inspectable evidence.

In practice:

- Do not accept "I finished" as clearance.
- Do not promote a skill, role, prompt, tool, runtime adapter, or agent target without a scorecard.
- Treat trace files, artifacts, replay results, verifier output, and issues as the review surface.
- Use `cleared/pass` as the only automatic trust result.
- Treat `held` as requiring human or follow-up review.
- Treat `rejected/unsafe` as blocked.

## Trigger Conditions

An agent should use the Barena clearance skill when it is asked to:

- Create, install, update, or trust a skill.
- Change a role, prompt, tool policy, runtime adapter, or agent target profile.
- Import capability code or instructions from an external repository.
- Decide whether a capability is safe enough for repeated use.
- Promote a capability from experimental to default, trusted, autonomous, or reusable.
- Review a capability that claims success but leaves weak or missing artifacts.

The skill does not need to trigger for ordinary application code changes unless the change modifies agent capability, autonomy, tool access, trust policy, or runtime behavior.

## Clearance Workflow

Use an isolated subjects/runs root when experimenting so the agent does not pollute the repository state:

```bash
tmp="$(mktemp -d)"
```

For a local skill:

```bash
barena import skill <skill-path> --id <subject-id> --subjects-root "$tmp/subjects"
barena scan <subject-id> --subjects-root "$tmp/subjects"
barena run <subject-id> --subjects-root "$tmp/subjects" --runs-root "$tmp/runs" --replays 3
barena report <run-id> --runs-root "$tmp/runs" --format markdown
```

For an external GitHub skill:

```bash
barena import github <owner/repo-or-url> --id <subject-id> --ref <ref> --subjects-root "$tmp/subjects"
barena scan <subject-id> --subjects-root "$tmp/subjects"
barena run <subject-id> --subjects-root "$tmp/subjects" --runs-root "$tmp/runs" --replays 3
```

For a built-in agent target:

```bash
barena list targets
barena import agent <opencode|xiaoba|hermes|openclaw> --id <subject-id> --subjects-root "$tmp/subjects"
barena run <subject-id> --subjects-root "$tmp/subjects" --runs-root "$tmp/runs" --replays 3
```

When a verifier exists, pass it into the run:

```bash
barena run <subject-id> --subjects-root "$tmp/subjects" --runs-root "$tmp/runs" --replays 3 --verifier <verifier-path>
```

If `barena` is not installed as a command, use the local build from this repository:

```bash
npm run build
node dist/cli.js doctor
```

Then replace `barena` in the commands above with:

```bash
node dist/cli.js
```

## Decision Policy

### `cleared` / `pass`

The subject may be treated as cleared for the reviewed scope. The agent should still report:

- Subject id and type.
- Run id.
- Replay count.
- Verifier result, if any.
- Evidence refs, especially report, trace, artifacts, and scorecard.
- Any scope caveats, such as deterministic adapter mode.

### `held`

The subject is not trusted yet. The agent should explain the issue family and recommend a concrete follow-up:

- `review_required`: scan warnings need review.
- `unstable`: replay failed or produced inconsistent evidence.
- `reopened`: verifier or reviewer found a blocking issue.
- `blocked`: runtime could not complete the required scenario.

Held subjects may be inspected manually, but should not be promoted to default or autonomous use.

### `rejected` / `unsafe`

The subject must not be trusted or executed as a capability. The agent should preserve the scorecard and issue refs, then recommend removal, quarantine, or explicit human review.

## Reporting Format

When responding to the user, keep the report short and evidence-first:

```text
Decision: cleared | held | rejected
Status: pass | unstable | reopened | blocked | unsafe
Subject: <id> (<type>)
Run: <run-id>
Replay: <pass>/<planned>
Verifier: pass | fail | not used
Evidence: <scorecard/report/trace/artifact refs>
Action: trust for reviewed scope | revise and rerun | block
```

Do not paste full scorecards unless the user asks. Summarize the blocking issue families and link or name the local files.

## Candidate Skill Layout

The first installable version should be intentionally small:

```text
barena-clearance/
  SKILL.md
  agents/openai.yaml
  references/
    command-recipes.md
    scorecard-policy.md
```

`SKILL.md` should hold only the trigger policy, core workflow, and decision rules. Detailed command variants and scorecard examples should live in references so the skill stays cheap to load.

The skill should not bundle the Barena CLI itself. It should discover either an installed `barena` command or the local repository path when present.

## Candidate `SKILL.md` Scope

The skill frontmatter should trigger on capability admission, not on every code review:

```yaml
---
name: barena-clearance
description: Use Barena to clear agent capabilities before trust or promotion. Trigger when creating, updating, installing, reviewing, or promoting skills, roles, prompts, tool policies, runtime adapters, external capability repositories, or agent target profiles; when deciding whether a capability is safe for repeated or autonomous use; or when a capability claims completion but needs trace, artifact, replay, verifier, and scorecard evidence.
---
```

The body should instruct the agent to:

- Locate `barena` or the repository-local `dist/cli.js`.
- Build Barena when using the local repository.
- Use temporary subject/run roots for exploratory clearance.
- Import, scan, run, and report.
- Read scorecard, issues, trace refs, artifact refs, replay refs, and verifier results.
- Apply the decision policy above.
- Refuse to mark a capability trusted when Barena is unavailable or inconclusive.

## Non-Goals

The Barena clearance skill should not:

- Execute arbitrary GitHub install scripts.
- Treat pattern-based static scan as complete malware detection.
- Hide `held` or `rejected` decisions behind friendly language.
- Copy XiaobaOS product surfaces, logs, secrets, Feishu, Weixin, Dashboard, Electron, or Pet code into Barena.
- Confuse the legacy deterministic `barena run` adapter (`xiaoba_invoked: false`) with XiaobaOS native Arena evaluation or portable external-agent verification.

## Open Questions

- Should the skill live in `~/.codex/skills/barena-clearance`, XiaobaOS's skill directory, or both?
- Should Barena expose a single `clear` command that wraps `import`, `scan`, `run`, and `report` for skill users?
- Should scorecard rendering be tolerant of older run schemas before the skill is dogfooded on existing runs?
- Which native and portable evidence profiles should the installable skill expose by default?
- Which additional portable driver examples are worth maintaining after OpenClaw and the Hermes-compatible sample?

## Rollout Plan

1. Create the installable `barena-clearance` skill from this document.
2. Dogfood it on one real XiaobaOS Skill and one intentionally unsafe fixture.
3. Add a compact command wrapper only if repeated use shows command friction.
4. Add backward-compatible report rendering for older scorecards before relying on historical runs.
5. Revisit the skill after real OpenClaw and Hermes wrapper smokes are available.
