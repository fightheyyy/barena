# Contributing to Barena

Thank you for helping improve Barena. The project is still pre-1.0, so focused changes with clear evidence are easier to review and maintain.

## Before you start

- Use Node.js 18 or newer and npm.
- Search existing issues and pull requests before starting overlapping work.
- Open an issue before a large behavioral or architectural change so its scope and compatibility impact can be discussed.
- Report security-sensitive findings through the process in [`SECURITY.md`](SECURITY.md), not in a public issue.

## Local workflow

Install the locked dependency set and run the repository checks:

```sh
npm ci
npm run check
```

Use `npm run pack:dry-run` when a change affects the CLI entry point, generated output, documentation links, examples, calibration data, or npm package contents.

## Change guidelines

- Keep pull requests small and explain the user-visible problem they solve.
- Add or update tests for behavior changes. Bug fixes should include a regression test when practical.
- Update public documentation when commands, contracts, evidence labels, or runtime support change.
- Preserve Barena's evidence boundaries: do not describe portable boundary evidence as native runtime evidence, and do not turn blocked or incomplete runs into successful release decisions.
- Avoid committing generated run output, credentials, local configuration, or machine-specific paths.
- Do not mix unrelated formatting or refactoring into a focused change.

## Pull requests

A pull request should include:

- a concise summary and motivation;
- the verification commands that were run and their results;
- any compatibility, security, or evidence-quality implications;
- documentation and tests needed to keep the change understandable.

By contributing, you agree that your contribution is provided under the repository's Apache-2.0 license.
