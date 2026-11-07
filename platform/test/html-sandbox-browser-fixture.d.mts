import type { BrowserRuntime } from '../../scripts/probe-browser-runtime.mjs';
import type { OriginRead } from './better-sidebar-browser-fixture.mjs';

/** What the probe page's own script wrote into `#result`: `ok` or the caught error's name. */
export interface ProbeScriptResult {
  readonly origin: string;
  readonly parent: string;
  readonly top: string;
  readonly cookie: string;
  readonly storage: string;
  readonly fetch: string;
  readonly state: string;
}

/** One load of the preview frame, read without page script; no URL, session id or cookie. */
export interface FrameLoad {
  /** The first request's route: `/sidebar/html` (any preview path) or the exact pathname. */
  readonly route: string;
  readonly status: number;
  /** The pathname a redirecting first response points to, or null. */
  readonly location: string | null;
  readonly csp: string | null;
  readonly nosniff: string | null;
  /** The first request's `sec-fetch-site` as sent, or null if Chrome reported no headers. */
  readonly secFetchSite: string | null;
  /** Whether the first request sent a cookie header (never its value), or null as above. */
  readonly cookie: boolean | null;
  /** Number of hops, redirects included. */
  readonly hops: number;
  /** The route of the document the frame ended on. */
  readonly finalRoute: string;
  readonly probe: boolean;
  readonly result: ProbeScriptResult | null;
  /** Read in an isolated world of the frame on the session that owns it. */
  readonly originRead: OriginRead;
  readonly screenshot: string;
}

/** The preview, the probe script's own navigation and the browser's navigation of one round. */
export interface FrameRound {
  readonly label: string;
  readonly preview: FrameLoad;
  readonly self: FrameLoad;
  readonly browser: FrameLoad;
}

export interface SandboxStatusBar {
  readonly unlock: boolean;
  readonly restore: boolean;
}

/** One sandbox toggle of the HTML viewer's settings popup and the mark after its label. */
export interface SandboxToggle {
  readonly title: string;
  readonly labelRects: number | null;
  readonly mark: string | null;
  readonly markText: string | null;
  readonly markRects: number;
}

export interface HtmlSandboxObservation {
  readonly phase: 'default' | 'employee';
  /** The iframe's `sandbox` attribute when the preview opened, or null. */
  readonly sandbox: string | null;
  readonly statusBar: SandboxStatusBar & { readonly screenshot?: string };
  readonly settings?: { readonly toggles: readonly SandboxToggle[]; readonly screenshot: string };
  readonly unlock?: {
    readonly sandbox: null;
    readonly statusBar: SandboxStatusBar;
    readonly screenshot: string;
  };
  readonly rounds: readonly FrameRound[];
  /** URL-redacted console errors of the probed frame that match the fixture's allowed fragments. */
  readonly allowedFrameConsole: readonly string[];
  readonly probeConsoleErrors: readonly string[];
  /** The main page's and every other target's console errors. */
  readonly consoleErrors: readonly string[];
  readonly attachFailures: readonly { readonly type: string; readonly error: string }[];
}

/** better-sidebar's HTML preview of the probe file, opened from its file area in a real browser. */
export declare function observeHtmlSandbox(input: {
  readonly origin: string;
  readonly cookie: string;
  readonly host: string;
  readonly runtime: BrowserRuntime;
  readonly evidence: string;
  readonly probe: { readonly name: string };
  readonly phase: 'default' | 'employee';
}): Promise<HtmlSandboxObservation>;
