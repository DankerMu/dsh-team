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
    /** Persist acquired prompt facts before any enrichment; called even if screenshot capture fails. */
    retain: (prompt: ModelPromptEvidence, screenshotCaptured: boolean) => Promise<void>;
  },
): Promise<void>;
