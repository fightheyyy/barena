# Source and adaptation

This calibration pack is derived from the Apache-2.0 SkillsBench `dialogue-parser` task at commit `5720102e3d6b0d3471b9715995ff96144d9eefb7`:

- Repository: https://github.com/benchflow-ai/skillsbench
- Upstream task: `tasks/dialogue-parser`
- Upstream task prompt copy: `source/dialogue-parser-task.md`
- Candidate Skill: adapted from `tasks/dialogue-parser/environment/skills/dialogue-graph/SKILL.md`

This is not an official SkillsBench or BenchFlow result. Barena rewrites absolute paths to workspace-relative paths, reduces the fixture, omits the executable `solution.py` parser and Graphviz output, and retains only the JSON graph outcome that its trusted declarative verifier can check without executing subject-authored code.
