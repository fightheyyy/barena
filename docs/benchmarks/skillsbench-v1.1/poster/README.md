# Barena × SkillsBench Poster

These publish-ready posters are generated deterministically from
[`../results/latest.json`](../results/latest.json). All chart values, task labels, evidence
counts, and claims are rendered by code; no image model is allowed to rewrite the data.

The audited edition leads with the comparable subset: 36 same-task, same-trial pairs
(72 rollouts across 14 tasks). Within those equal denominators, baseline passes 14/36
(38.9%) and candidate passes 20/36 (55.6%), an observed paired difference of +16.7
percentage points. There are 8 candidate-only passes and 2 baseline-only passes; the exact
two-sided McNemar p-value is 0.109, so the direction is positive but not conclusive.

The release-gate panel covers only the 9 tasks with complete three-by-three evidence:
2 `cleared`, 7 `held`, and 0 `rejected`. The 90 verifier-admitted rollouts remain visible as
an evidence inventory; 18 admitted but unpaired rollouts are excluded from the effect
estimate, and 15 incomplete tasks are excluded from task-level effect claims.

## Exports

- `barena-skillsbench-black-gold.png`: recommended main-conference / README visual
- `barena-skillsbench-paper-white.png`: paper-results / print-friendly direction
- `barena-skillsbench-midnight-blue.png`: systems-evaluation / presentation direction

Each poster is exported at 1600 × 2200 pixels. The SVG source and
[`manifest.json`](manifest.json) are retained for audit and future regeneration.

## Regenerate

```bash
node docs/benchmarks/skillsbench-v1.1/poster/generate-posters.mjs

for file in docs/benchmarks/skillsbench-v1.1/poster/*.svg; do
  sips -s format png "$file" --out "${file%.svg}.png"
done
```
