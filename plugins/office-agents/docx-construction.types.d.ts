/** Narrow public rc.2 service views; native DSH retains execution ownership. */
interface Session {
  header: { cwd?: string };
}
interface Execution {
  agent?: { session: Session };
  signal: AbortSignal;
}
interface Receipt {
  path: string;
  bytes: number;
  sha256: string;
  uid: number;
}
interface ShellRequest {
  command: string;
  stdin: string;
  workdir: string;
  timeoutMs: number;
  onExpiry: 'kill';
  stdoutMaxBytes: number;
  sandboxPolicy: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}
interface ShellResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  stdout: { text: string; truncated?: boolean };
  sandbox?: { denied?: boolean; runnerFailed?: boolean };
}
interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: Receipt): { type: 'text'; text: string }[];
    presentationMeta(args: unknown, value: Receipt): Receipt;
  };
  execute(input: unknown, exec: Execution): Promise<Receipt>;
}
export interface Context {
  tools: { register(tool: Tool): unknown };
  sandboxPolicy: {
    resolve(options: { session: Session }): Readonly<Record<string, unknown>>;
  };
  shell: {
    resolve(request: ShellRequest): ShellRequest;
    execute(spec: ShellRequest): Promise<{ result(): Promise<ShellResult> }>;
  };
}
