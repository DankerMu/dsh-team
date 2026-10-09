export interface GatewayUpstream {
  readonly host: string;
  readonly port: number;
  readonly cookie: string;
}

export type GatewayUpstreamResolver = (userId: string) => GatewayUpstream | undefined;
