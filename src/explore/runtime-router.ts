import type {
  AgentRuntimeAdapter,
  AgentRuntimeSession,
  OpenRuntimeSessionRequest,
  RuntimeCapabilities,
  RuntimeProbeRequest,
  RuntimeProbeResult,
  RuntimeTurnInput,
  RuntimeTurnResult,
} from "../runtime-adapters";

/** Routes only the target stage to a different Runtime. Evaluator stages stay
 * on XiaoBaOS, preserving the UserCat → target → InspectorCat → ReviewerCat DAG.
 */
export class ExploreRuntimeRouter implements AgentRuntimeAdapter {
  readonly id: string;
  readonly capabilities: RuntimeCapabilities;
  private readonly routes = new Map<string, AgentRuntimeAdapter>();

  constructor(
    private readonly target: AgentRuntimeAdapter,
    private readonly evaluator: AgentRuntimeAdapter,
    private readonly targetRole: string
  ) {
    this.id = target.id;
    this.capabilities = target.capabilities;
  }

  async probe(request: RuntimeProbeRequest = {}): Promise<RuntimeProbeResult> {
    const requested = request.required_targets ?? [];
    const targetProbe = await this.target.probe({ required_targets: [this.targetRole] });
    if (targetProbe.status === "blocked") return targetProbe;
    if (this.target === this.evaluator) return this.evaluator.probe(request);
    const evaluatorProbe = await this.evaluator.probe({
      required_targets: requested.filter((role) => role !== this.targetRole),
    });
    if (evaluatorProbe.status === "blocked") {
      return {
        ...evaluatorProbe,
        detail: `Evaluator Runtime blocked: ${evaluatorProbe.detail}`,
      };
    }
    return {
      ...targetProbe,
      detail: `${targetProbe.detail} XiaoBaOS evaluator Roles are ready.`,
      validated_targets: [...new Set([
        ...targetProbe.validated_targets,
        ...evaluatorProbe.validated_targets,
      ])],
    };
  }

  async openSession(request: OpenRuntimeSessionRequest): Promise<AgentRuntimeSession> {
    const adapter = request.attempt_id === "target" ? this.target : this.evaluator;
    const session = await adapter.openSession(request);
    this.routes.set(session.session_id, adapter);
    return session;
  }

  sendTurn(session: AgentRuntimeSession, turn: RuntimeTurnInput): Promise<RuntimeTurnResult> {
    return this.route(session).sendTurn(session, turn);
  }

  cancel(session: AgentRuntimeSession, reason: string): Promise<boolean> {
    return this.route(session).cancel(session, reason);
  }

  async close(session: AgentRuntimeSession): Promise<void> {
    const adapter = this.route(session);
    try {
      await adapter.close(session);
    } finally {
      this.routes.delete(session.session_id);
    }
  }

  private route(session: AgentRuntimeSession): AgentRuntimeAdapter {
    return this.routes.get(session.session_id) ??
      (session.runtime_id === this.target.id ? this.target : this.evaluator);
  }
}
