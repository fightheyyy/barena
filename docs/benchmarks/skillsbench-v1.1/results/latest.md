# Barena × SkillsBench Validation

- Validation: `skillsbench-validation-20260727035114-913afabe`
- Dataset: SkillsBench 1.1 @ `b63b7b285022`
- Selection: `skillsbench-v1.1-validation-24` / SHA-256 `4fa6ea66a9116d71f0a2709b689188ac57c6245d2bc0a73a5595a21cc4c6ec5d`
- Runtime: XiaoBaOS / requested model `gpt-5.6-sol` / `linux/amd64`
- Matrix: 24 tasks × 2 arms × 3 trials = 144 rollouts
- Executed evidence: 144/144 rollouts (execution complete: true)
- Verifier-admitted scores: 90/144 rollouts
- Matched comparison set: 36 same-task/same-trial pairs (72 rollouts across 14 tasks)
- Excluded from performance statistics: 54 rollouts (37 numeric rewards invalidated by the evidence audit; 17 upstream-unscored)
- Complete task comparisons: 9/24
- Reported usage: 30,518,481 prompt + 640,337 completion tokens; estimated cost $11.6201

## Matched trial-pair analysis

| Matched pairs | Baseline pass | Candidate pass | Paired pass difference | Candidate-only pass | Baseline-only pass | Exact McNemar p |
|---:|---:|---:|---:|---:|---:|---:|
| 36 | 14/36 (38.9%) | 20/36 (55.6%) | +16.7 pp | 8 | 2 | 0.109 |

This is a complete-case paired estimate: only trials with admitted verifier evidence in both arms are compared. It is descriptive, and missingness may be non-random.

## Complete-task release gate

| Complete tasks | Baseline pass | Candidate pass | Observed difference | Cleared | Held | Rejected |
|---:|---:|---:|---:|---:|---:|---:|
| 9 | 10/27 (37.0%) | 16/27 (59.3%) | +22.2 pp | 2 | 7 | 0 |

Held reasons among complete tasks: 4 no effect and 3 unstable. The other 15 tasks remain outside the task-level effect conclusion because their three-by-three evidence is incomplete.

## Evidence inventory

| Terminal rollouts | Verifier-admitted | Used in matched pairs | Admitted but unpaired | Invalid / unscored |
|---:|---:|---:|---:|---:|
| 144 | 90 | 72 | 18 | 54 |

Only the matched-pair subset contributes to the human-facing effect comparison. Unmatched arm rates remain machine-readable audit fields in JSON and are intentionally not presented as a result.

## Complete tasks

| Task | Category | Reference | Baseline pass | Candidate pass | Baseline score | Candidate score | Score lift | Gate | Reason |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| invoice-fraud-detection | finance-economics | negative | 1/3 (33.3%) | 1/3 (33.3%) | 33.3% | 33.3% | 0.0 pp | held | unstable_result |
| 3d-scan-calc | industrial-physical-systems | neutral | 3/3 (100.0%) | 3/3 (100.0%) | 100.0% | 100.0% | 0.0 pp | held | no_effect |
| hvac-control | industrial-physical-systems | negative | 3/3 (100.0%) | 3/3 (100.0%) | 100.0% | 100.0% | 0.0 pp | held | no_effect |
| bike-rebalance | mathematics-or-formal-reasoning | positive | 1/3 (33.3%) | 3/3 (100.0%) | 33.3% | 100.0% | +66.7 pp | cleared | positive_lift |
| exam-block-sequencing | mathematics-or-formal-reasoning | negative | 2/3 (66.7%) | 2/3 (66.7%) | 66.7% | 66.7% | 0.0 pp | held | unstable_result |
| video-silence-remover | media-content-production | neutral | 0/3 (0.0%) | 0/3 (0.0%) | 0.0% | 0.0% | 0.0 pp | held | no_effect |
| lake-warming-attribution | natural-science | positive | 0/3 (0.0%) | 1/3 (33.3%) | 0.0% | 33.3% | +33.3 pp | held | unstable_result |
| sales-pivot-analysis | office-white-collar | positive | 0/3 (0.0%) | 0/3 (0.0%) | 0.0% | 0.0% | 0.0 pp | held | no_effect |
| llm-prefix-cache-replay | software-engineering | positive | 0/3 (0.0%) | 3/3 (100.0%) | 0.0% | 100.0% | +100.0 pp | cleared | positive_lift |

All 24 task records, including the 15 incomplete comparisons, remain available in the machine-readable JSON evidence index.

## Interpretation

- Only the upstream SkillsBench verifier determines task pass or fail.
- A numeric upstream reward is admitted only when a non-empty CTRF report or a completed pytest summary proves that the verifier executed; incomplete multi-report suites are excluded.
- The primary capability comparison uses only same-task, same-trial pairs with admitted verifier evidence in both arms; unpaired admitted rollouts remain in the evidence inventory but not in the effect estimate.
- The paired-trial result is a complete-case analysis. Missingness may be non-random, so the observed lift and exact McNemar p-value do not establish population-level superiority.
- Published per-task reference direction guided selection and is not XiaoBaOS ground truth.
- XiaoBaOS is invoked through a Barena ACP compatibility shim because XiaoBaOS 0.2.0 is not a native ACP agent.
- Task containers run as linux/amd64 to match the published SkillsBench environments; the upstream task snapshot remains byte-verified while build transport may use public mirrors or a checksum-verified local artifact cache without changing package versions or verifier logic.
- Raw rollout directories and trajectories remain local under runs/; the public JSON report preserves their portable repository-relative references.
- Token and cost totals are copied from BenchFlow final metrics; cost is an estimate, not a billing statement.
- The requested model is configuration evidence; this report does not independently attest the proxy-resolved backend.
