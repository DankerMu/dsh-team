import type { BrowserRuntime } from '../../scripts/probe-browser-runtime.mjs';

/** In-page JS expressions (not CSS selectors) yielding one visible element, or nothing. */
export declare function rowQuery(name: string): string;
export declare function explorerReselect(name: string): string;
export declare const EXPAND_BUTTON: string;
export declare const FILES_GUIDE: string;

/**
 * In-page JS expressions over DSH's document preview of one file, evaluated by value. The
 * outcome's `state` is null while its container is absent or unsettled; `code` only for
 * `data-textpreview-failed`.
 */
export interface PreviewOutcome {
  readonly state: 'rendered' | 'failed' | null;
  readonly code?: string;
  readonly message?: string;
  readonly pages: number;
  readonly nativeHost: boolean;
  readonly fontWarning: boolean;
}
export declare function previewOutcome(previewId: string, name: string): string;
/** Yields null without a matched container. */
export interface PreviewFacts {
  readonly labels: readonly string[];
  /** Editable surfaces other than Fortune-sheet's cell input, which `cellInput` reports. */
  readonly contentEditable: number;
  readonly cellInput: boolean;
  readonly editors: number;
  readonly iframes: number;
  readonly cell: string | null;
}
export declare function previewFacts(previewId: string, name: string): string;
export interface CellInputState {
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
  readonly cell: string | null;
  readonly zIndex: string | null;
}
export declare function cellInputState(previewId: string, name: string): string;

/** A workspace file the employee opens from better-sidebar's explorer. */
interface SidebarFile {
  readonly name: string;
}

export interface SidebarHandoffObservation {
  readonly markdown: {
    readonly nativeHost: boolean;
    readonly paragraph: boolean;
    readonly dshMarkdown: boolean;
    readonly screenshot: string;
  };
  /** The recorded Office outcome, judged by the caller: a code only for `data-textpreview-failed`. */
  readonly docx: {
    readonly state: 'rendered' | 'failed';
    readonly code?: string;
    readonly message?: string;
    readonly pages: number;
    readonly nativeHost: boolean;
    readonly fontWarning: boolean;
    readonly downloads: number;
    readonly editors: number;
    readonly screenshot: string;
  };
  readonly consoleErrors: readonly string[];
}

/** Real browser handoff on the employee's platform origin; evidence is written to `evidence`. */
export declare function observeSidebarHandoff(input: {
  readonly origin: string;
  readonly cookie: string;
  readonly host: string;
  readonly runtime: BrowserRuntime;
  readonly evidence: string;
  readonly markdown: SidebarFile & { readonly heading: string; readonly paragraph: string };
  readonly docx: SidebarFile;
}): Promise<SidebarHandoffObservation>;

/** `self.origin` and the error name, or `ok`, of reading `localStorage` and `document.cookie`. */
export interface OriginRead {
  readonly origin: string;
  readonly storage: string;
  readonly cookie: string;
}

/** One top-level document of the probe tab, read without page script; no URL is recorded. */
export interface WorkspaceDocumentProbe {
  readonly status: number;
  readonly contentType: string | null;
  readonly csp: string | null;
  readonly nosniff: string | null;
  /** Read in an isolated world of the document's main frame. */
  readonly originRead: OriginRead;
  /** The probe file's static marker is in the DOM: the document is the probe file. */
  readonly probe: boolean;
  /** The outer HTML of the element the probe's own script writes, or null if it never ran. */
  readonly ran: string | null;
  readonly screenshot: string;
}

export interface WorkspaceDocumentObservation {
  readonly markdown: SidebarHandoffObservation['markdown'];
  readonly image: { readonly naturalWidth: number; readonly screenshot: string };
  /** The same read on the platform page: the read's own positive control. */
  readonly platformOriginRead: OriginRead;
  readonly document: WorkspaceDocumentProbe;
  readonly preview: WorkspaceDocumentProbe;
  /** URL-redacted sandbox notices of the probe tab, the only console errors allowed there. */
  readonly blockedScripts: readonly string[];
  readonly probeConsoleErrors: readonly string[];
  readonly consoleErrors: readonly string[];
}

/** The workspace HTML probe opened as a document via `/sidebar/file` and `/sidebar/html`. */
export declare function observeWorkspaceDocument(input: {
  readonly origin: string;
  readonly cookie: string;
  readonly host: string;
  readonly runtime: BrowserRuntime;
  readonly evidence: string;
  readonly markdown: SidebarFile & {
    readonly heading: string;
    readonly paragraph: string;
    readonly image: string;
  };
  readonly probePath: string;
}): Promise<WorkspaceDocumentObservation>;
