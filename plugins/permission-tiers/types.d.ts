interface PermissionState {
  preset: string | null;
  sandbox: string | null;
  approval: string | null;
}
export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact';
export interface Session {
  id: string;
  header: { cwd?: string; origin?: string; parentSession?: string };
  append(type: string, data: Record<string, unknown>): unknown;
  requestHeader(): { config: { provider?: string; model?: string } } | undefined;
}
interface PromptAssembly {
  contexts: { name: string; text: string }[];
}
export interface Agent {
  session: Session;
  options: { provider?: string; model?: string };
  ctx: {
    systemPrompt: {
      context(value: { name: string; order: number; text: string }): unknown;
      getContextOrder(name: string): number;
    };
    on(
      event: 'system-prompt/assemble',
      callback: (
        assembly: PromptAssembly,
        context: unknown,
        next: () => Promise<PromptAssembly>,
      ) => Promise<PromptAssembly>,
    ): unknown;
  };
  cancel(cause: { kind: 'disposed' | 'user' }, options?: { keepInbox?: boolean }): void;
  whenIdle(): Promise<void>;
}
export interface Execution {
  name: string;
  callId: string;
  arguments: unknown;
  schema?: unknown;
  agent?: Agent;
  signal: AbortSignal;
}
export type Decision =
  | { kind: 'allow' | 'cancel' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string; displayReason?: { en: string; zh: string } };
export interface Chunk {
  type: string;
  index?: number;
  text?: string;
  blockType?: string;
  block?: { type: string; text?: string };
  reason?: { kind: string };
}
export interface ReviewContext {
  llm: { stream(options: Readonly<Record<string, unknown>>): AsyncIterable<Chunk> };
  tools?: { schemas(agent: Agent): { name: string; [key: string]: unknown }[] };
}
export interface Context extends ReviewContext {
  permissionPresets: { resolve(name: string): { sandbox: string; approval: string } };
  sessionProjections: { stateOf(session: Session, key: string): PermissionState | undefined };
  agents: { get(id: string): Agent | undefined; list(): Agent[] };
  tools: {
    guard(callback: (exec: Execution) => string | undefined): () => unknown;
    schemas(agent: Agent): { name: string; [key: string]: unknown }[];
  };
  // Public declarations allow void; the pinned implementation returns awaited effect cleanup.
  provide(name: string, service: unknown): () => void | Promise<void>;
  on(
    event: 'tools/pre-execute',
    callback: (exec: Execution, next: () => Promise<Decision>) => Promise<Decision>,
    options?: { prepend: boolean },
  ): () => unknown;
  on(event: 'tools/result', callback: (exec: Execution) => void): () => unknown;
  on(
    event: 'session/event',
    callback: (session: Session, event: { type: string }) => void,
  ): () => unknown;
  on(
    event: 'agent/created',
    callback: (payload: { agent: Agent; source: SessionStartSource }) => void,
  ): () => unknown;
  on(event: 'agent/disposed', callback: (payload: { agent: Agent }) => void): () => unknown;
  effect(factory: () => Iterable<() => unknown>): unknown;
}
