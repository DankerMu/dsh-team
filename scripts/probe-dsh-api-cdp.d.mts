import type { IncomingHttpHeaders, RequestOptions } from 'node:http';
import type { ChromeLaunchInput } from './probe-browser-runtime.mjs';

export type CdpPage = {
  send(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>;
  on(method: string, handler: (params: Record<string, unknown>) => void): void;
  close(): void;
};
export type ChromeHandle = { readonly browserWs: string; stop(): Promise<void> };
export type NetworkRequestEvent = {
  requestId: string;
  request: { url: string; method?: string; initialPriority?: string; postData?: string };
  type?: string;
  timestamp?: number;
};
export type NetworkResponseEvent = {
  requestId: string;
  response: { status: number; url?: string };
  type?: string;
  timestamp?: number;
};
export type NetworkTerminalEvent = {
  requestId: string;
  type?: string;
  timestamp?: number;
  errorText?: string;
  canceled?: boolean;
};
export type NetworkObservers = {
  'Network.requestWillBeSent'?: (params: NetworkRequestEvent) => void;
  'Network.responseReceived'?: (params: NetworkResponseEvent) => void;
  'Network.loadingFinished'?: (params: NetworkTerminalEvent) => void;
  'Network.loadingFailed'?: (params: NetworkTerminalEvent) => void;
  'Network.resourceChangedPriority'?: (params: { requestId: string; newPriority?: string }) => void;
};
export type WelcomeObserver = {
  readonly state: {
    readonly controllerId: string | undefined;
    readonly failure: string | undefined;
  };
  cleanup(): Promise<void>;
};
export type MuxStore = {
  ready: boolean;
  closed?: boolean;
  reason?: string | null;
  events: { sessionId: string; running: boolean; t: number }[];
};
export declare function sleep(ms: number): Promise<void>;
export declare function httpRequest(
  options: RequestOptions,
  body?: string,
  ms?: number,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>;
export declare function connectPage(browserWs: string): Promise<CdpPage>;
export declare function observeNetwork(page: CdpPage, handlers: NetworkObservers): () => void;
export declare function startChrome(input: ChromeLaunchInput): Promise<ChromeHandle>;
export declare function exchangeLaunchToken(input: {
  host: string;
  port: number;
  token: string;
  cookieHost?: string;
}): Promise<string>;
export declare function rpcCall(
  origin: string,
  cookie: string,
  method: string,
  payload: unknown,
  connectHost?: string,
): Promise<unknown>;
export declare function muxListen(
  origin: string,
  cookie: string,
  store: MuxStore,
): Promise<{ store: MuxStore; close(): void }>;
export declare function armWelcomeStoreObserver(page: CdpPage): Promise<WelcomeObserver>;
export declare function waitWelcomeStoreReady(
  page: CdpPage,
  observer: WelcomeObserver,
  ms: number,
): Promise<unknown>;
