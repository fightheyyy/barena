import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("public Barena execution routes do not import the legacy XiaobaOS Arena runner", () => {
  const publicRoutes = [
    "src/cli/main.ts",
    "src/cli/guide.ts",
    "src/tui/evaluation-tui.ts",
    "src/e2e/case-runner.ts",
    "src/evaluation/run-skill-evaluation.ts",
    "src/evaluation/index.ts",
  ].map((file) => fs.readFileSync(path.resolve(file), "utf8")).join("\n");

  assert.doesNotMatch(publicRoutes, /from ["'][^"']*xiaoba-native-runner["']/);
  assert.doesNotMatch(publicRoutes, /from ["'][^"']*xiaoba-native-input["']/);
  assert.doesNotMatch(publicRoutes, /from ["'][^"']*live-policy["']/);
  assert.doesNotMatch(publicRoutes, /runXiaoBaNativeEvaluation|probeXiaoBaNativeRuntime|createXiaoBaNative/);
});

test("production build excludes the legacy XiaobaOS Arena executable modules", () => {
  const excluded = [
    "dist/evaluation/live-policy.js",
    "dist/evaluation/xiaoba-native-input.js",
    "dist/evaluation/xiaoba-native-runner.js",
    "dist/evaluators/xiaoba-evaluator-runtime.js",
  ];
  for (const relative of excluded) {
    assert.equal(fs.existsSync(path.resolve(relative)), false, `${relative} must not be shipped`);
  }
});
