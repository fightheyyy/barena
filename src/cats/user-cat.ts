import { SubjectManifest, UserScenario } from "../domain/types";

export function createUserCatScenarios(subject: SubjectManifest): UserScenario[] {
  const agentTarget = subject.metadata.agent_target as { default_scenarios?: UserScenario[] } | undefined;
  if (subject.type === "agent" && agentTarget?.default_scenarios?.length) {
    return agentTarget.default_scenarios;
  }

  return [
    {
      scenario_id: "low-info-primary",
      prompt: `I installed ${subject.subject_id}. Use it for a realistic task and show evidence that it worked.`,
      max_turns: 4,
    },
    {
      scenario_id: "low-info-followup",
      prompt: "Can you do that again but leave a concrete artifact I can inspect?",
      max_turns: 4,
    },
  ];
}
