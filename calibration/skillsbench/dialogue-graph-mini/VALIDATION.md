# XiaobaOS validation protocol

This pack uses the pinned SkillsBench `dialogue-parser` task to validate Barena's two product lanes against the same XiaobaOS Harness change:

| Lane | Case | Question |
|---|---|---|
| Fixed-case replay | `skillsbench-dialogue-graph-mini` | Does the candidate preserve a known, explicitly specified capability across independent attempts? |
| UserCat Agent E2E | `skillsbench-dialogue-graph-usercat-boundary` | Can the candidate recover the required artifact from a low-information request, with one adaptive follow-up available, without seeing the hidden oracle? |

The experiment keeps the XiaobaOS Role, model, fixtures, and verifier constant. The baseline runs the Role without the candidate `dialogue-graph` Skill; the candidate runs the same Role with that Skill. Both cases use the same hidden structured verifier for `dialogue.json`. The upstream executable `solution.py` parser requirement is explicitly omitted: this calibration validates the graph outcome without executing subject-authored code.

An Inspector-discovered failure from the E2E lane is a replay-case candidate for a later Harness version. It is not silently added to the current run, so the persisted experiment remains a DAG.

## Run contract

Use the validation manifest rather than the onboarding-only starter manifest:

```bash
barena eval skill calibration/skillsbench/dialogue-graph-mini/skill/dialogue-graph \
  --target xiaobaos \
  --role engineer-cat \
  --case-pack calibration/skillsbench/dialogue-graph-mini/xiaoba-validation-pack.json \
  --attempts 2 \
  --live-policy /absolute/path/to/live-policy.json
```

Do not start model-backed execution unless `barena doctor --target xiaobaos` proves the live runtime contract and the supplied policy passes preflight. For subscription-backed local gateways, use `billing_mode=subscription`, zero-dollar accounting, a verified subscription entitlement, and enforced call/token limits; never invent API token prices.

## Interpretation

This is a SkillsBench-derived Barena calibration, not an official SkillsBench or BenchFlow result. A publishable validation report must retain the upstream revision and task hash, record every adaptation, preserve byte-identical prompts between baseline and candidate for each case, prove candidate-only Skill activation, and include the persisted traces, artifacts, verifier results, replay counts, provider telemetry, and Barena decision.

## Current evidence — 2026-07-21

| Gate | Status | Evidence |
|---|---|---|
| Case provenance | Pass | One pinned upstream task and SHA-256 project into two unique Barena cases while persisted `task_ids` stays deduplicated. |
| Hidden artifact oracle | Pass | The structured verifier accepts the expected graph and rejects valid-JSON semantic near misses such as unreachable nodes. |
| Paired orchestration contract | Pass, deterministic fixture only | The fake XiaobaOS contract produces `0/2` baseline versus `2/2` candidate outcomes across the replay and E2E cases. This proves plumbing, not model quality. |
| Full repository regression | Pass | `npm run check`: 175/175 automated tests. |
| Package inclusion | Pass | `npm pack --dry-run --ignore-scripts --json`: 257 files, including both cases, this protocol, the validation manifest, and the live-policy template. |
| Local XiaobaOS structural probe | Pass | XiaobaOS 0.2.0 exposes the required native Arena import, snapshot, prepare, and execute surfaces. |
| Local additive XiaobaOS live safety contract | Pass | The local audit-contract patch exposes credential-free `arena live-contract --json`, enforces provider/model, call, token, retry, and telemetry bounds, and passes Barena preflight. This is not yet a released XiaobaOS 0.2.0 capability. |
| Real provider-boundary smoke | Held | Persisted run `xiaoba-skill-eval-20260721100935-f06681` reached the baseline target call, retained native/Arena/verifier evidence, passed redaction and scratch cleanup, then stopped on `PROVIDER_AUTH_ERROR` (`401`; trace tokens `0/0`; billing usage unavailable; zero retry). The candidate arm did not start, so effectiveness remains unavailable. |
| Completed model-backed paired result | Not available | A provider request was attempted, but authorization failed before any model output or usage evidence. No live lift or release claim is made. |

The held provider boundary is part of the validation result: Barena did not trade auditability for a convenient benchmark number. The next executable step is to refresh the local provider authorization, rerun this manifest, and publish the complete baseline/candidate package. Released XiaobaOS must also ship the additive audit contract before stock installations can perform the live run.
