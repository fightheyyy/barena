import type {
  InspectorIssue,
  InspectorOutput,
  ReviewerCriterionResult,
  ReviewerOutput,
  UserSimulatorDecision,
} from "./types";

export function parseUserSimulatorDecision(text: string): UserSimulatorDecision {
  const value = objectJson(text);
  if (value.action !== "send" && value.action !== "stop") {
    throw new Error("user simulator action must be send or stop");
  }
  const reason = requiredString(value.reason, "user simulator reason", 4_000);
  if (value.action === "send") {
    return {
      action: "send",
      message: requiredString(value.message, "user simulator message", 16_000),
      reason,
    };
  }
  return { action: "stop", reason };
}

export function parseInspectorOutput(text: string): InspectorOutput {
  const value = objectJson(text);
  if (typeof value.evidence_complete !== "boolean") {
    throw new Error("inspector evidence_complete must be boolean");
  }
  if (!Array.isArray(value.issues) || value.issues.length > 100) {
    throw new Error("inspector issues must be an array with at most 100 entries");
  }
  const issues: InspectorIssue[] = value.issues.map((entry, index) => {
    const issue = record(entry, `inspector issue ${index + 1}`);
    if (!["info", "warning", "blocking", "unsafe"].includes(String(issue.severity))) {
      throw new Error(`inspector issue ${index + 1} has invalid severity`);
    }
    return {
      issue_id: safeId(issue.issue_id, `inspector issue ${index + 1} issue_id`),
      severity: issue.severity as InspectorIssue["severity"],
      family: requiredString(issue.family, `inspector issue ${index + 1} family`, 200),
      summary: requiredString(issue.summary, `inspector issue ${index + 1} summary`, 8_000),
      evidence: stringArray(issue.evidence, `inspector issue ${index + 1} evidence`, 50, 4_000),
      ...(optionalString(issue.replay_prompt, 16_000) && {
        replay_prompt: optionalString(issue.replay_prompt, 16_000),
      }),
    };
  });
  return {
    summary: requiredString(value.summary, "inspector summary", 12_000),
    evidence_complete: value.evidence_complete,
    issues,
  };
}

export function parseReviewerOutput(text: string): ReviewerOutput {
  const value = objectJson(text);
  if (!["pass", "fail", "blocked", "unsafe"].includes(String(value.verdict))) {
    throw new Error("reviewer verdict must be pass, fail, blocked, or unsafe");
  }
  if (!Array.isArray(value.criteria) || value.criteria.length > 100) {
    throw new Error("reviewer criteria must be an array with at most 100 entries");
  }
  const criteria: ReviewerCriterionResult[] = value.criteria.map((entry, index) => {
    const criterion = record(entry, `reviewer criterion ${index + 1}`);
    if (!["pass", "fail", "unknown"].includes(String(criterion.status))) {
      throw new Error(`reviewer criterion ${index + 1} has invalid status`);
    }
    return {
      criterion: requiredString(
        criterion.criterion,
        `reviewer criterion ${index + 1} criterion`,
        4_000
      ),
      status: criterion.status as ReviewerCriterionResult["status"],
      evidence: stringArray(
        criterion.evidence,
        `reviewer criterion ${index + 1} evidence`,
        50,
        4_000
      ),
    };
  });
  const scores = record(value.scores, "reviewer scores");
  return {
    verdict: value.verdict as ReviewerOutput["verdict"],
    summary: requiredString(value.summary, "reviewer summary", 12_000),
    criteria,
    scores: {
      task_success: score(scores.task_success, "task_success"),
      safety: score(scores.safety, "safety"),
      evidence_quality: score(scores.evidence_quality, "evidence_quality"),
    },
  };
}

function objectJson(text: string): Record<string, unknown> {
  for (const candidate of jsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error("response did not contain one valid JSON object");
}

function jsonCandidates(text: string): string[] {
  const candidates = [text.trim()];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]) candidates.push(match[1].trim());
  }
  const balanced = firstBalancedObject(text);
  if (balanced) candidates.push(balanced);
  return [...new Set(candidates.filter(Boolean))];
}

function firstBalancedObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${label} must be a non-empty string up to ${max} characters`);
  }
  return value.trim();
}

function optionalString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max
    ? value.trim()
    : undefined;
}

function safeId(value: unknown, label: string): string {
  const text = requiredString(value, label, 120);
  if (!/^[A-Za-z0-9._-]+$/.test(text)) throw new Error(`${label} must be a safe identifier`);
  return text;
}

function stringArray(
  value: unknown,
  label: string,
  maxItems: number,
  maxLength: number
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${label} must be an array with at most ${maxItems} entries`);
  }
  return value.map((entry, index) =>
    requiredString(entry, `${label}[${index}]`, maxLength)
  );
}

function score(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`reviewer score ${label} must be a number from 0 to 1 or 0 to 100`);
  }
  return value <= 1 ? value : value / 100;
}
