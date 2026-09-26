import type { GatewayConfig } from './config-types';
import type { TunnelSpawn } from './tunnel-types';
import type { WorkspaceGateway } from './workspace/gateway';

/** Derive injected services from the route factories so their contracts stay aligned. */
type ServiceDependencies =
  NonNullable<Parameters<typeof import('../routes/chat').createChatRouter>[1]> &
  NonNullable<Parameters<typeof import('../routes/voice').createVoiceRouter>[1]> &
  NonNullable<Parameters<typeof import('../routes/live2d').createLive2dRouter>[1]> &
  NonNullable<Parameters<typeof import('../routes/anima').createAnimaRouter>[1]> &
  NonNullable<Parameters<typeof import('../routes/generation').createGenerationRouter>[1]> &
  NonNullable<Parameters<typeof import('../routes/video').createVideoRouter>[1]> &
  NonNullable<Parameters<typeof import('../routes/video-ai').createVideoAiRouter>[1]>;

export interface GatewayOptions {
  config?: GatewayConfig;
  env?: NodeJS.ProcessEnv;
  spawn?: TunnelSpawn;
  services?: Partial<ServiceDependencies>;
  control?: NonNullable<Parameters<typeof import('../routes/control').createControlRouter>[2]>;
  /** In-process capability only: absent by default, never inferred from a public token or env path. */
  workspace?: WorkspaceGateway;
}

export interface GatewayState {
  tunnelUrl: string;
  startTunnel: (() => void) | null;
  stopTunnel: (() => void) | null;
}
