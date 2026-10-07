import type { MappedHostAcceptInput } from './probe-mapped-host.mjs';

export interface ModelPromptEvidence {
  sessionId: string;
  requestId: string;
  accepted: boolean;
  promptCount: number;
  created: boolean;
  visibleError: boolean;
  consoleErrorCount: number;
}

export declare function captureModelRefusal(
  input: MappedHostAcceptInput & {
    beforeSubmit: () => void | Promise<void>;
    observe: (prompt: ModelPromptEvidence) => Promise<boolean>;
    retain: (prompt: ModelPromptEvidence) => Promise<void>;
  },
): Promise<void>;
