interface Session {
  header: {
    origin?: string;
    parentSession?: string;
    isSeeded?: boolean;
    delegationDepth?: number;
  };
}
interface Agent {
  ctx: object;
  session: Session;
}
/** Narrow view of the public rc.2 services; runtime ownership remains with DSH. */
export interface Context {
  agents: { get(id: string): Agent | undefined };
  agentPresets: {
    composedPreset(scope: object): string | undefined;
    select(agent: Agent, preset: string): Promise<string>;
  };
  sessionProjections: {
    stateOf(session: Session, key: 'subagent'): { identity?: { mode: string } } | undefined;
  };
  on(
    event: 'agent/created',
    listener: (event: {
      agent: Agent;
      source: 'startup' | 'resume' | 'clear' | 'compact';
      signal: AbortSignal;
    }) => Promise<void>,
  ): unknown;
}
