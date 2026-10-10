export interface GatewayUpstream {
  readonly outcome: 'running';
  readonly host: string;
  readonly port: number;
  readonly cookie: string;
}

export type GatewayUnavailableReason = 'stopped' | 'starting' | 'full' | 'error' | 'unconfigured';

export type GatewayUpstreamResolver = (
  userId: string,
) => GatewayUpstream | { readonly outcome: GatewayUnavailableReason };
