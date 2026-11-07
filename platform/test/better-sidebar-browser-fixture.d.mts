import type { BrowserRuntime } from '../../scripts/probe-browser-runtime.mjs';

/** In-page JS expressions (not CSS selectors) yielding one visible element, or nothing. */
export declare function rowQuery(name: string): string;
export declare function explorerReselect(name: string): string;
export declare const EXPAND_BUTTON: string;
export declare const FILES_GUIDE: string;

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
  /** The recorded, unasserted Office outcome: a code only for `data-textpreview-failed`. */
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
