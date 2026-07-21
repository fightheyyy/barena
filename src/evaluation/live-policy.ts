import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isXiaoBaNativeContractVersion } from "./xiaoba-native-types";
import type {
  XiaoBaCapabilityEvaluationRequestV1,
  XiaoBaLivePolicyBinding,
  XiaoBaLivePolicyPreflight,
  XiaoBaLivePolicyV1,
  XiaoBaLiveRuntimeContractV1,
  XiaoBaNativeReasonCode,
  XiaoBaProviderCallComponent,
} from "./xiaoba-native-types";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const MAX_PRIVATE_BETA_BUDGET_USD = 5;
const PRICING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const HARD_LIMIT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const HARD_LIMIT_MODES = new Set([
  "provider_account_limit",
  "provider_project_limit",
  "api_key_limit",
  "metering_proxy",
  "prepaid_balance",
  "subscription_entitlement",
]);
const BILLING_MODES = new Set(["metered", "subscription"]);
const PROVIDER_CALL_COMPONENTS: XiaoBaProviderCallComponent[] = [
  "target",
  "usercat",
  "inspector",
  "reviewer",
  "replay",
];

export class XiaoBaLivePolicyValidationError extends Error {}

export type LoadedXiaoBaLivePolicy = XiaoBaLivePolicyBinding;

export interface EvaluateXiaoBaLivePreflightInput {
  binding: XiaoBaLivePolicyBinding;
  request: XiaoBaCapabilityEvaluationRequestV1;
  environment: NodeJS.ProcessEnv;
  runtime_contract?: XiaoBaLiveRuntimeContractV1;
  runtime_contract_ref?: string;
  retained_policy_ref?: string;
  retained_policy_sha256?: string;
  now?: Date;
}

export function loadXiaoBaLivePolicy(policyPath: string): LoadedXiaoBaLivePolicy {
  const policyRef = path.resolve(policyPath);
  if (!fs.existsSync(policyRef) || !fs.statSync(policyRef).isFile()) {
    throw new XiaoBaLivePolicyValidationError(`Live policy file does not exist: ${policyRef}`);
  }
  const source = fs.readFileSync(policyRef);
  const sourceText = source.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText);
  } catch (error) {
    throw new XiaoBaLivePolicyValidationError(
      `Live policy is not valid JSON: ${policyRef}. ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return createBinding(validateXiaoBaLivePolicy(parsed), policyRef, sourceText);
}

export function bindXiaoBaLivePolicy(
  policyValue: unknown,
  policyRef = "memory://barena/live-policy.json"
): LoadedXiaoBaLivePolicy {
  const policy = validateXiaoBaLivePolicy(policyValue);
  return createBinding(policy, policyRef, stableJson(policy));
}

export function validateXiaoBaLivePolicyBinding(value: unknown): LoadedXiaoBaLivePolicy {
  const binding = record(value, "live policy binding");
  if (binding.schema !== "barena.loaded_live_policy.v1") {
    throw new XiaoBaLivePolicyValidationError("live policy binding schema must be barena.loaded_live_policy.v1");
  }
  const policyRef = requiredString(binding.policy_ref, "live policy binding policy_ref");
  const sourceText = requiredString(binding.source_text, "live policy binding source_text", false);
  const sourceSha256 = sha256(binding.source_sha256, "live policy binding source_sha256");
  const canonicalSha256 = sha256(binding.canonical_sha256, "live policy binding canonical_sha256");
  if (hashBytes(Buffer.from(sourceText, "utf8")) !== sourceSha256) {
    throw new XiaoBaLivePolicyValidationError("live policy binding source bytes do not match source_sha256");
  }
  let sourceValue: unknown;
  try {
    sourceValue = JSON.parse(sourceText);
  } catch (error) {
    throw new XiaoBaLivePolicyValidationError(
      `live policy binding source_text is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const sourcePolicy = validateXiaoBaLivePolicy(sourceValue);
  const suppliedPolicy = validateXiaoBaLivePolicy(binding.policy);
  const canonicalText = stableJson(sourcePolicy);
  if (hashBytes(Buffer.from(canonicalText, "utf8")) !== canonicalSha256) {
    throw new XiaoBaLivePolicyValidationError("live policy binding canonical bytes do not match canonical_sha256");
  }
  if (canonicalText !== stableJson(suppliedPolicy)) {
    throw new XiaoBaLivePolicyValidationError("live policy binding policy does not match the bound source bytes");
  }
  return deepFreeze({
    schema: "barena.loaded_live_policy.v1",
    policy: sourcePolicy,
    policy_ref: policyRef,
    source_text: sourceText,
    source_sha256: sourceSha256,
    canonical_sha256: canonicalSha256,
  });
}

export function validateXiaoBaLivePolicy(value: unknown): XiaoBaLivePolicyV1 {
  const policy = record(value, "live policy");
  if (policy.schema !== "barena.live_policy.v1") {
    throw new XiaoBaLivePolicyValidationError("live policy schema must be barena.live_policy.v1");
  }

  const billingMode = policy.billing_mode === undefined
    ? "metered"
    : requiredString(policy.billing_mode, "live policy billing_mode");
  if (!BILLING_MODES.has(billingMode)) {
    throw new XiaoBaLivePolicyValidationError(
      `live policy billing_mode must be one of ${[...BILLING_MODES].join(", ")}`
    );
  }

  const provider = requiredString(policy.provider, "live policy provider");
  const model = requiredString(policy.model, "live policy model");
  const credentialEnv = envName(policy.credential_env, "live policy credential_env");
  const apiBaseEnv = envName(policy.api_base_env, "live policy api_base_env");
  const maxInputTokens = positiveInteger(policy.max_input_tokens, "live policy max_input_tokens");
  const maxOutputTokens = positiveInteger(policy.max_output_tokens, "live policy max_output_tokens");
  const maxProviderCalls = positiveInteger(policy.max_provider_calls, "live policy max_provider_calls");

  const pricingValue = record(policy.pricing, "live policy pricing");
  const pricingProvider = requiredString(pricingValue.provider, "live policy pricing.provider");
  const pricingModel = requiredString(pricingValue.model, "live policy pricing.model");
  const pricingApiBaseEnv = envName(pricingValue.api_base_env, "live policy pricing.api_base_env");
  const pricingCurrency = usd(pricingValue.currency, "live policy pricing.currency");
  const inputPrice = billingMode === "subscription" ? nonNegativeNumber(
    pricingValue.input_usd_per_million_tokens,
    "live policy pricing.input_usd_per_million_tokens"
  ) : positiveNumber(
    pricingValue.input_usd_per_million_tokens,
    "live policy pricing.input_usd_per_million_tokens"
  );
  const outputPrice = billingMode === "subscription" ? nonNegativeNumber(
    pricingValue.output_usd_per_million_tokens,
    "live policy pricing.output_usd_per_million_tokens"
  ) : positiveNumber(
    pricingValue.output_usd_per_million_tokens,
    "live policy pricing.output_usd_per_million_tokens"
  );
  const pricingSource = requiredString(pricingValue.source, "live policy pricing.source");
  const sourcedAt = isoDate(pricingValue.sourced_at, "live policy pricing.sourced_at");
  if (pricingProvider !== provider || pricingModel !== model || pricingApiBaseEnv !== apiBaseEnv) {
    throw new XiaoBaLivePolicyValidationError(
      "live policy pricing must bind the top-level provider, model, and api_base_env"
    );
  }

  const budgetUsd = billingMode === "subscription"
    ? nonNegativeNumber(policy.budget_usd, "live policy budget_usd")
    : positiveNumber(policy.budget_usd, "live policy budget_usd");
  if (budgetUsd > MAX_PRIVATE_BETA_BUDGET_USD) {
    throw new XiaoBaLivePolicyValidationError(
      `live policy budget_usd must be at most ${MAX_PRIVATE_BETA_BUDGET_USD}`
    );
  }
  const worstCaseUsd = billingMode === "subscription"
    ? nonNegativeNumber(policy.worst_case_usd, "live policy worst_case_usd")
    : positiveNumber(policy.worst_case_usd, "live policy worst_case_usd");

  const hardLimitValue = record(policy.hard_limit, "live policy hard_limit");
  const hardLimitMode = requiredString(hardLimitValue.mode, "live policy hard_limit.mode");
  if (!HARD_LIMIT_MODES.has(hardLimitMode)) {
    throw new XiaoBaLivePolicyValidationError(
      `live policy hard_limit.mode must be one of ${[...HARD_LIMIT_MODES].join(", ")}`
    );
  }
  if (typeof hardLimitValue.verified !== "boolean") {
    throw new XiaoBaLivePolicyValidationError("live policy hard_limit.verified must be boolean");
  }
  const hardLimitReference = requiredString(
    hardLimitValue.reference,
    "live policy hard_limit.reference"
  );
  const hardLimitVerifiedAt = isoDate(
    hardLimitValue.verified_at,
    "live policy hard_limit.verified_at"
  );
  const hardLimitProvider = requiredString(
    hardLimitValue.provider,
    "live policy hard_limit.provider"
  );
  const hardLimitCredentialEnv = envName(
    hardLimitValue.credential_env,
    "live policy hard_limit.credential_env"
  );
  const hardLimitApiBaseEnv = envName(
    hardLimitValue.api_base_env,
    "live policy hard_limit.api_base_env"
  );
  const hardLimitCurrency = usd(hardLimitValue.currency, "live policy hard_limit.currency");
  const hardLimitCapUsd = billingMode === "subscription"
    ? nonNegativeNumber(hardLimitValue.cap_usd, "live policy hard_limit.cap_usd")
    : positiveNumber(hardLimitValue.cap_usd, "live policy hard_limit.cap_usd");
  if (
    hardLimitProvider !== provider ||
    hardLimitCredentialEnv !== credentialEnv ||
    hardLimitApiBaseEnv !== apiBaseEnv
  ) {
    throw new XiaoBaLivePolicyValidationError(
      "live policy hard_limit must bind the top-level provider, credential_env, and api_base_env"
    );
  }
  if (billingMode === "subscription") {
    if (inputPrice !== 0 || outputPrice !== 0 || budgetUsd !== 0 || worstCaseUsd !== 0 || hardLimitCapUsd !== 0) {
      throw new XiaoBaLivePolicyValidationError(
        "subscription live policy must use zero token prices, budget_usd, worst_case_usd, and hard_limit.cap_usd"
      );
    }
    if (hardLimitMode !== "subscription_entitlement") {
      throw new XiaoBaLivePolicyValidationError(
        "subscription live policy hard_limit.mode must be subscription_entitlement"
      );
    }
  } else if (hardLimitMode === "subscription_entitlement") {
    throw new XiaoBaLivePolicyValidationError(
      "metered live policy cannot use hard_limit.mode subscription_entitlement"
    );
  }

  const acceptedScanFindingIds = uniqueStringArray(
    policy.accepted_scan_finding_ids,
    "live policy accepted_scan_finding_ids"
  );
  const retentionValue = record(policy.retention, "live policy retention");
  const retentionProfile = requiredString(retentionValue.profile, "live policy retention.profile");
  const redactionValue = record(policy.redaction, "live policy redaction");
  const redactionProfile = requiredString(redactionValue.profile, "live policy redaction.profile");
  const secretEnvNames = uniqueStringArray(
    redactionValue.secret_env_names,
    "live policy redaction.secret_env_names"
  ).map((name) => envName(name, "live policy redaction.secret_env_names entry"));
  const structuredFieldNames = redactionValue.structured_field_names === undefined
    ? []
    : uniqueStringArray(redactionValue.structured_field_names, "live policy redaction.structured_field_names");

  return deepFreeze({
    schema: "barena.live_policy.v1",
    billing_mode: billingMode as "metered" | "subscription",
    provider,
    model,
    credential_env: credentialEnv,
    api_base_env: apiBaseEnv,
    max_input_tokens: maxInputTokens,
    max_output_tokens: maxOutputTokens,
    max_provider_calls: maxProviderCalls,
    pricing: {
      provider: pricingProvider,
      model: pricingModel,
      api_base_env: pricingApiBaseEnv,
      currency: pricingCurrency,
      input_usd_per_million_tokens: inputPrice,
      output_usd_per_million_tokens: outputPrice,
      source: pricingSource,
      sourced_at: sourcedAt,
    },
    budget_usd: budgetUsd,
    worst_case_usd: worstCaseUsd,
    hard_limit: {
      mode: hardLimitMode as XiaoBaLivePolicyV1["hard_limit"]["mode"],
      verified: hardLimitValue.verified,
      reference: hardLimitReference,
      verified_at: hardLimitVerifiedAt,
      provider: hardLimitProvider,
      credential_env: hardLimitCredentialEnv,
      api_base_env: hardLimitApiBaseEnv,
      currency: hardLimitCurrency,
      cap_usd: hardLimitCapUsd,
    },
    accepted_scan_finding_ids: [...acceptedScanFindingIds].sort(),
    retention: { profile: retentionProfile },
    redaction: {
      profile: redactionProfile,
      secret_env_names: [...secretEnvNames].sort(),
      ...(structuredFieldNames.length > 0 && {
        structured_field_names: [...structuredFieldNames].sort(),
      }),
    },
  });
}

export function validateXiaoBaLiveRuntimeContract(value: unknown): XiaoBaLiveRuntimeContractV1 {
  const contract = record(value, "XiaobaOS live runtime contract");
  if (contract.schema !== "barena.xiaoba_live_runtime_contract.v1") {
    throw new XiaoBaLivePolicyValidationError(
      "XiaobaOS live runtime contract schema must be barena.xiaoba_live_runtime_contract.v1"
    );
  }
  if (
    !isXiaoBaNativeContractVersion(contract.xiaoba_version) ||
    contract.composite_call_contract !== "barena.xiaoba_composite_calls.v1" ||
    contract.provider_call_record_schema !== "barena.provider_call.v1"
  ) {
    throw new XiaoBaLivePolicyValidationError("XiaobaOS live runtime contract version is unsupported");
  }
  const bounds = record(contract.bounds, "XiaobaOS live runtime contract bounds");
  const enforcement = record(contract.enforcement, "XiaobaOS live runtime contract enforcement");
  const targetCallsPerTurn = boundedPositiveInteger(bounds.target_calls_per_turn, "XiaobaOS live runtime contract bounds.target_calls_per_turn", 32);
  const usercatCallsPerTurn = boundedPositiveInteger(bounds.usercat_calls_per_turn, "XiaobaOS live runtime contract bounds.usercat_calls_per_turn", 4);
  const replayCallsPerCaseTurn = boundedPositiveInteger(bounds.replay_calls_per_case_turn, "XiaobaOS live runtime contract bounds.replay_calls_per_case_turn", 32);
  for (const name of ["inspector_calls_per_attempt", "reviewer_calls_per_attempt"] as const) {
    if (bounds[name] !== 0) {
      throw new XiaoBaLivePolicyValidationError(`XiaobaOS live runtime contract bounds.${name} must be 0`);
    }
  }
  if (
    enforcement.input_token_limit !== true ||
    enforcement.output_token_limit !== true ||
    enforcement.sdk_max_retries !== 0 ||
    enforcement.authoritative_per_call_telemetry !== true ||
    enforcement.complete_provider_identity !== true ||
    enforcement.complete_cost_basis !== true
  ) {
    throw new XiaoBaLivePolicyValidationError("XiaobaOS live runtime contract enforcement is incomplete");
  }
  return deepFreeze({
    schema: "barena.xiaoba_live_runtime_contract.v1",
    xiaoba_version: contract.xiaoba_version,
    composite_call_contract: "barena.xiaoba_composite_calls.v1",
    provider_call_record_schema: "barena.provider_call.v1",
    bounds: {
      target_calls_per_turn: targetCallsPerTurn,
      usercat_calls_per_turn: usercatCallsPerTurn,
      inspector_calls_per_attempt: 0,
      reviewer_calls_per_attempt: 0,
      replay_calls_per_case_turn: replayCallsPerCaseTurn,
    },
    enforcement: {
      input_token_limit: true,
      output_token_limit: true,
      sdk_max_retries: 0,
      authoritative_per_call_telemetry: true,
      complete_provider_identity: true,
      complete_cost_basis: true,
    },
  });
}

export function evaluateXiaoBaLivePreflight(
  input: EvaluateXiaoBaLivePreflightInput
): XiaoBaLivePolicyPreflight {
  const binding = validateXiaoBaLivePolicyBinding(input.binding);
  const policy = binding.policy;
  const now = input.now ?? new Date();
  let runtimeContract: XiaoBaLiveRuntimeContractV1 | undefined;
  try {
    runtimeContract = input.runtime_contract
      ? validateXiaoBaLiveRuntimeContract(input.runtime_contract)
      : undefined;
  } catch {
    runtimeContract = undefined;
  }
  const callPlan = calculateProviderCallPlan(input.request, runtimeContract);
  const plannedBarenaAttempts = input.request.cases.length * input.request.attempts_per_arm * 2;
  const plannedProviderCalls = Object.values(callPlan).reduce((sum, value) => sum + value, 0);
  const calculatedWorstCaseUsd = calculateWorstCaseUsd(policy, plannedProviderCalls);
  const singleAttemptSmoke = input.request.attempts_per_arm === 1;
  const singleAttemptSmokeValid = !singleAttemptSmoke || (
    input.request.cases.length === 1 &&
    input.request.cases.every((item) =>
      item.max_turns === 1 && item.replay_attempts === 1 && item.max_replay_cases === 1
    )
  );
  const credentialPresent = nonEmptyEnvironmentValue(input.environment[policy.credential_env]);
  const apiBasePresent = nonEmptyEnvironmentValue(input.environment[policy.api_base_env]);
  const pricingFreshness = freshness(policy.pricing.sourced_at, now, PRICING_MAX_AGE_MS);
  const hardLimitFreshness = freshness(policy.hard_limit.verified_at, now, HARD_LIMIT_MAX_AGE_MS);
  const runtimeContractVerified = Boolean(runtimeContract);
  const retryControlVerified = runtimeContract?.enforcement.sdk_max_retries === 0;
  const providerTelemetryVerified = runtimeContract?.enforcement.authoritative_per_call_telemetry === true &&
    runtimeContract.enforcement.complete_provider_identity === true &&
    runtimeContract.enforcement.complete_cost_basis === true;
  const hardLimitCoversBudget = policy.hard_limit.cap_usd <= policy.budget_usd;
  const worstCaseWithinHardLimit = policy.worst_case_usd <= policy.hard_limit.cap_usd &&
    calculatedWorstCaseUsd <= policy.hard_limit.cap_usd;
  const checks: XiaoBaLivePolicyPreflight["checks"] = [];

  checks.push(check(
    "provider_identity_configured",
    true,
    `Provider ${policy.provider} and model ${policy.model} are pinned by the bound live policy.`
  ));
  checks.push(check(
    "policy_source_bound",
    true,
    `Policy source ${binding.policy_ref} is bound to ${binding.source_sha256}.`
  ));
  checks.push(check(
    "credential_present",
    credentialPresent,
    credentialPresent
      ? `Credential environment ${policy.credential_env} is present.`
      : `Credential environment ${policy.credential_env} is missing or empty.`
  ));
  checks.push(check(
    "api_base_present",
    apiBasePresent,
    apiBasePresent
      ? `API base environment ${policy.api_base_env} is present.`
      : `API base environment ${policy.api_base_env} is missing or empty.`
  ));
  checks.push(check(
    "pricing_fresh",
    pricingFreshness === "fresh",
    `Pricing evidence is ${pricingFreshness}: ${policy.pricing.sourced_at}.`
  ));
  checks.push(check(
    "hard_limit_verified",
    policy.hard_limit.verified,
    policy.hard_limit.verified
      ? `Hard limit ${policy.hard_limit.mode} is externally verified by ${policy.hard_limit.reference}.`
      : `Hard limit ${policy.hard_limit.mode} is not verified.`
  ));
  checks.push(check(
    "hard_limit_fresh",
    hardLimitFreshness === "fresh",
    `Hard-limit evidence is ${hardLimitFreshness}: ${policy.hard_limit.verified_at}.`
  ));
  checks.push(check(
    "runtime_contract_verified",
    runtimeContractVerified,
    runtimeContractVerified
      ? `Live runtime contract ${runtimeContract!.composite_call_contract} is verified.`
      : "XiaobaOS does not expose the required live runtime contract."
  ));
  checks.push(check(
    "retry_control_verified",
    retryControlVerified,
    retryControlVerified
      ? "The runtime contract verifies SDK maximum retries are zero."
      : "The runtime does not prove SDK maximum retries are zero."
  ));
  checks.push(check(
    "provider_call_telemetry_verified",
    providerTelemetryVerified,
    providerTelemetryVerified
      ? "The runtime contract verifies target/evaluator per-call identity, usage, and cost telemetry."
      : "The runtime does not prove complete target/evaluator per-call telemetry."
  ));
  checks.push(check(
    "declared_worst_case_covers_calculation",
    policy.worst_case_usd + Number.EPSILON >= calculatedWorstCaseUsd,
    `Declared worst case is $${policy.worst_case_usd}; calculated reservation is $${calculatedWorstCaseUsd}.`
  ));
  checks.push(check(
    "hard_limit_within_budget",
    hardLimitCoversBudget,
    `External hard cap is $${policy.hard_limit.cap_usd}; evaluation budget is $${policy.budget_usd}.`
  ));
  checks.push(check(
    "worst_case_within_hard_limit",
    worstCaseWithinHardLimit,
    `Declared/calculated worst cases are $${policy.worst_case_usd}/$${calculatedWorstCaseUsd}; hard cap is $${policy.hard_limit.cap_usd}.`
  ));
  checks.push(check(
    "provider_call_limit_covers_plan",
    plannedProviderCalls <= policy.max_provider_calls,
    `${plannedBarenaAttempts} Barena attempts reserve ${plannedProviderCalls} provider calls; policy permits ${policy.max_provider_calls}.`
  ));
  checks.push(check(
    "single_attempt_smoke_is_minimal",
    singleAttemptSmokeValid,
    singleAttemptSmoke
      ? "A one-attempt smoke requires exactly one case with max_turns=1, replay_attempts=1, and max_replay_cases=1."
      : "This is not the one-attempt private-beta smoke lane."
  ));

  let reasonCode: XiaoBaNativeReasonCode | undefined;
  let summary = policy.billing_mode === "subscription"
    ? "Bound subscription policy, runtime call/token limits, identity, retry, and telemetry checks are ready."
    : "Bound live policy, runtime contract, budget, identity, retry, and telemetry checks are ready.";
  if (!credentialPresent || !apiBasePresent) {
    reasonCode = "xiaoba_provider_unconfigured";
    summary = "Live provider credential or API base configuration is missing.";
  } else if (pricingFreshness !== "fresh") {
    reasonCode = "live_pricing_stale";
    summary = "Live pricing evidence is stale or future-dated.";
  } else if (!policy.hard_limit.verified) {
    reasonCode = "live_hard_limit_unverified";
    summary = "The live provider spend boundary is not externally verified.";
  } else if (hardLimitFreshness !== "fresh") {
    reasonCode = "live_hard_limit_stale";
    summary = "The live hard-limit verification is stale or future-dated.";
  } else if (policy.worst_case_usd + Number.EPSILON < calculatedWorstCaseUsd) {
    reasonCode = "live_worst_case_understated";
    summary = "The declared worst-case cost is lower than the reserved execution plan calculates.";
  } else if (!hardLimitCoversBudget || !worstCaseWithinHardLimit) {
    reasonCode = "live_budget_exceeded";
    summary = "The declared/calculated live cost is not bounded by an external cap no greater than the evaluation budget.";
  } else if (!singleAttemptSmokeValid) {
    reasonCode = "live_smoke_configuration_invalid";
    summary = "The one-attempt private-beta smoke is not constrained to one case, one turn, and one internal replay.";
  } else if (plannedProviderCalls > policy.max_provider_calls) {
    reasonCode = "live_provider_call_limit_insufficient";
    summary = "The provider-call limit cannot cover target, evaluator, and replay calls in the paired plan.";
  } else if (!runtimeContractVerified) {
    reasonCode = "live_runtime_contract_unsupported";
    summary = "XiaobaOS 0.1.1 does not prove an evaluator-inclusive call bound and per-call control contract.";
  } else if (!retryControlVerified) {
    reasonCode = "live_retry_control_unverified";
    summary = "The live runtime does not prove automatic provider retries are disabled.";
  } else if (!providerTelemetryVerified) {
    reasonCode = "live_provider_call_telemetry_unverified";
    summary = "The live runtime does not prove complete target and evaluator provider-call telemetry.";
  }

  const ready = reasonCode === undefined;
  return {
    schema: "barena.xiaoba_live_preflight.v1",
    status: ready ? "ready" : "held",
    ready_to_invoke: ready,
    model_invoked: false,
    ...(reasonCode && { reason_code: reasonCode }),
    summary,
    policy_ref: input.retained_policy_ref ?? binding.policy_ref,
    source_policy_ref: binding.policy_ref,
    policy_sha256: binding.source_sha256,
    source_policy_sha256: binding.source_sha256,
    canonical_policy_sha256: binding.canonical_sha256,
    ...(input.retained_policy_sha256 && { retained_policy_sha256: input.retained_policy_sha256 }),
    runtime_contract: {
      status: runtimeContractVerified ? "verified" : "unsupported",
      ...(runtimeContract && { contract: runtimeContract }),
      evidence_refs: input.runtime_contract_ref ? [input.runtime_contract_ref] : [],
    },
    provider_identity: {
      provider: policy.provider,
      model: policy.model,
      source: "live_policy",
      status: "configured",
      evidence_refs: input.retained_policy_ref ? [input.retained_policy_ref] : [],
    },
    credentials: {
      credential_env: policy.credential_env,
      credential_present: credentialPresent,
      api_base_env: policy.api_base_env,
      api_base_present: apiBasePresent,
    },
    budget: {
      billing_mode: policy.billing_mode ?? "metered",
      budget_usd: policy.budget_usd,
      declared_worst_case_usd: policy.worst_case_usd,
      calculated_worst_case_usd: calculatedWorstCaseUsd,
      max_input_tokens_per_call: policy.max_input_tokens,
      max_output_tokens_per_call: policy.max_output_tokens,
      max_provider_calls: policy.max_provider_calls,
      planned_barena_attempts: plannedBarenaAttempts,
      planned_provider_calls: plannedProviderCalls,
      planned_calls_by_component: callPlan,
      pricing: policy.pricing,
      hard_limit: policy.hard_limit,
      enforcement: {
        hard_limit_verified: policy.hard_limit.verified,
        retry_control_status: retryControlVerified ? "verified" : "unverified",
        no_automatic_paid_retry: retryControlVerified,
        provider_call_telemetry_status: providerTelemetryVerified ? "verified" : "unverified",
        per_call_input_limit_verified: runtimeContract?.enforcement.input_token_limit === true,
        per_call_output_limit_env: "XIAOBA_LLM_MAX_TOKENS",
        local_estimate_is_not_hard_limit: true,
      },
    },
    retention: policy.retention,
    redaction: {
      profile: policy.redaction.profile,
      secret_env_names: policy.redaction.secret_env_names,
      structured_field_names: policy.redaction.structured_field_names ?? [],
    },
    checks,
  };
}

export function calculateProviderCallPlan(
  request: XiaoBaCapabilityEvaluationRequestV1,
  runtimeContract?: XiaoBaLiveRuntimeContractV1,
): Record<XiaoBaProviderCallComponent, number> {
  const bounds = runtimeContract?.bounds ?? {
    target_calls_per_turn: 1,
    usercat_calls_per_turn: 1,
    inspector_calls_per_attempt: 0,
    reviewer_calls_per_attempt: 0,
    replay_calls_per_case_turn: 1,
  };
  const totals: Record<XiaoBaProviderCallComponent, number> = {
    target: 0,
    usercat: 0,
    inspector: 0,
    reviewer: 0,
    replay: 0,
  };
  for (const item of request.cases) {
    const maxTurns = item.max_turns ?? 4;
    const replayAttempts = item.replay_attempts ?? 1;
    const maxReplayCases = item.max_replay_cases ?? 1;
    const barenaAttempts = request.attempts_per_arm * 2;
    totals.target += maxTurns * bounds.target_calls_per_turn * barenaAttempts;
    // The opening user message is case-authored. UserCat only invokes its
    // planner after observing a target response to choose a follow-up.
    totals.usercat += Math.max(0, maxTurns - 1) * bounds.usercat_calls_per_turn * barenaAttempts;
    totals.inspector += bounds.inspector_calls_per_attempt * barenaAttempts;
    totals.reviewer += bounds.reviewer_calls_per_attempt * barenaAttempts;
    totals.replay += replayAttempts * maxReplayCases * maxTurns * bounds.replay_calls_per_case_turn * barenaAttempts;
  }
  return totals;
}

export function calculateWorstCaseUsd(
  policy: XiaoBaLivePolicyV1,
  providerCalls = policy.max_provider_calls
): number {
  if (policy.billing_mode === "subscription") return 0;
  const perCall = (
    policy.max_input_tokens * policy.pricing.input_usd_per_million_tokens +
    policy.max_output_tokens * policy.pricing.output_usd_per_million_tokens
  ) / 1_000_000;
  return roundUsd(perCall * providerCalls);
}

export function estimatedUsageCostUsd(
  inputTokens: number,
  outputTokens: number,
  policy: XiaoBaLivePolicyV1
): number {
  if (policy.billing_mode === "subscription") return 0;
  return roundUsd((
    inputTokens * policy.pricing.input_usd_per_million_tokens +
    outputTokens * policy.pricing.output_usd_per_million_tokens
  ) / 1_000_000);
}

export function collectLiveSecretValues(
  policy: XiaoBaLivePolicyV1,
  environment: NodeJS.ProcessEnv,
  paidEnvironmentNames: string[] = []
): Array<{ env_name: string; value: string }> {
  const names = new Set([
    policy.credential_env,
    ...policy.redaction.secret_env_names,
    ...paidEnvironmentNames,
  ]);
  const secrets: Array<{ env_name: string; value: string }> = [];
  for (const name of names) {
    const value = environment[name];
    if (nonEmptyEnvironmentValue(value)) secrets.push({ env_name: name, value: String(value) });
  }
  return secrets.sort((left, right) => right.value.length - left.value.length || left.env_name.localeCompare(right.env_name));
}

function createBinding(
  policy: XiaoBaLivePolicyV1,
  policyRef: string,
  sourceText: string
): LoadedXiaoBaLivePolicy {
  const binding: XiaoBaLivePolicyBinding = {
    schema: "barena.loaded_live_policy.v1",
    policy,
    policy_ref: policyRef,
    source_text: sourceText,
    source_sha256: hashBytes(Buffer.from(sourceText, "utf8")),
    canonical_sha256: hashBytes(Buffer.from(stableJson(policy), "utf8")),
  };
  return validateXiaoBaLivePolicyBinding(binding);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)])
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function freshness(value: string, now: Date, maxAgeMs: number): "fresh" | "stale" | "future" {
  const observed = Date.parse(value);
  const current = now.getTime();
  if (observed > current + MAX_FUTURE_SKEW_MS) return "future";
  if (current - observed > maxAgeMs) return "stale";
  return "fresh";
}

function check(name: string, ok: boolean, detail: string): XiaoBaLivePolicyPreflight["checks"][number] {
  return { name, ok, detail };
}

function hashBytes(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function roundUsd(value: number): number {
  return Number(value.toFixed(12));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new XiaoBaLivePolicyValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, trim = true): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new XiaoBaLivePolicyValidationError(`${label} must be a non-empty string`);
  }
  return trim ? value.trim() : value;
}

function envName(value: unknown, label: string): string {
  const name = requiredString(value, label);
  if (!ENV_NAME.test(name)) throw new XiaoBaLivePolicyValidationError(`${label} must be a valid environment variable name`);
  return name;
}

function sha256(value: unknown, label: string): string {
  const digest = requiredString(value, label).toLowerCase();
  if (!SHA256.test(digest)) throw new XiaoBaLivePolicyValidationError(`${label} must be a SHA-256 digest`);
  return digest;
}

function usd(value: unknown, label: string): "USD" {
  if (value !== "USD") throw new XiaoBaLivePolicyValidationError(`${label} must be USD`);
  return "USD";
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new XiaoBaLivePolicyValidationError(`${label} must be a positive integer`);
  }
  return value;
}

function boundedPositiveInteger(value: unknown, label: string, maximum: number): number {
  const parsed = positiveInteger(value, label);
  if (parsed > maximum) {
    throw new XiaoBaLivePolicyValidationError(`${label} must be at most ${maximum}`);
  }
  return parsed;
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new XiaoBaLivePolicyValidationError(`${label} must be a positive finite number`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new XiaoBaLivePolicyValidationError(`${label} must be a non-negative finite number`);
  }
  return number;
}

function uniqueStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim().length > 0)) {
    throw new XiaoBaLivePolicyValidationError(`${label} must be an array of non-empty strings`);
  }
  const normalized = value.map((entry) => entry.trim());
  if (new Set(normalized).size !== normalized.length) {
    throw new XiaoBaLivePolicyValidationError(`${label} must not contain duplicates`);
  }
  return normalized;
}

function isoDate(value: unknown, label: string): string {
  const text = requiredString(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new XiaoBaLivePolicyValidationError(`${label} must be an ISO date-time`);
  return new Date(text).toISOString();
}

function nonEmptyEnvironmentValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
