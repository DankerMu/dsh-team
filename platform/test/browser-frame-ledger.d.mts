import type { CdpSession, CdpTarget } from '../../scripts/probe-dsh-api-cdp.mjs';

/** One hop of a frame document: a redirect's answer, or the final response. */
export interface FrameHop {
  readonly url: string;
  readonly status: number;
  /** Lower-cased response headers. */
  readonly headers: Readonly<Record<string, string>>;
  /** The pathname a redirect points to, or null. */
  readonly location: string | null;
  /** `sec-fetch-site` as sent, or null when Chrome reported no request headers in time. */
  readonly secFetchSite: string | null;
  /** Whether a cookie header was sent (never its value), or null as above. */
  readonly cookie: boolean | null;
}

/** One frame document, merged from whichever sessions reported it; the last hop committed. */
export interface FrameDocument {
  readonly requestId: string;
  /** The first hop's URL. */
  readonly url: string;
  readonly hops: readonly FrameHop[];
}

/** One console error event as reported; `key` is `page` or the reporting child's session id. */
export interface ConsoleRow {
  readonly key: string;
  readonly kind: 'log' | 'exception' | 'console';
  readonly text: string;
  readonly requestId?: string;
  /** The frame named by the row's execution context or document URL when it arrived. */
  readonly frameId?: string;
}

export interface ConsoleReport {
  /** Every error event the page session reported, attributed anywhere. */
  readonly pageEvents: number;
  readonly allowed: readonly ConsoleRow[];
  readonly probeErrors: readonly ConsoleRow[];
  readonly otherErrors: readonly ConsoleRow[];
}

export interface FrameTracker {
  /** The attached iframe target of `frameId`, else the page session. */
  owner(frameId: string): CdpSession;
  known(): Set<string>;
  nextDocument(
    frameId: string,
    before: ReadonlySet<string>,
    accept: (url: string) => boolean,
    ms: number,
    label: string,
  ): Promise<FrameDocument>;
  consoleReport(frameId: string): ConsoleReport;
  failures(): { readonly type: string; readonly error: string }[];
  dispose(): void;
}

/** A URL's pathname, any `/sidebar/html/<session>/…` preview path collapsed to `/sidebar/html`. */
export declare function routeOf(url: string): string;

/** Track every session of `page`; `allowed` are fragment sets tolerated only in the probed frame. */
export declare function trackFrames(
  page: Pick<CdpTarget, 'send' | 'listen' | 'session'>,
  allowed: readonly (readonly string[])[],
): Promise<FrameTracker>;
