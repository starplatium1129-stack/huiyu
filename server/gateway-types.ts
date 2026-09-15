import type { GatewayConfig } from './config-types';
import type { TunnelSpawn } from './tunnel-types';

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
}

export interface GatewayState {
  tunnelUrl: string;
  startTunnel: (() => void) | null;
  stopTunnel: (() => void) | null;
}
