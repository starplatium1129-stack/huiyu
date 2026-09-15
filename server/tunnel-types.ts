import type { SpawnOptions } from 'node:child_process';
import type { GatewayConfig } from './config-types';

export interface TunnelProcess {
  pid?: number | null;
  unref(): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export type TunnelSpawn = (command: string, args: readonly string[], options: SpawnOptions) => TunnelProcess;

export type TunnelConfig = Pick<GatewayConfig, 'CLOUDFLARED_PATH' | 'PORT'> & {
  DISABLE_TUNNEL?: boolean;
  RUNTIME: Pick<GatewayConfig['RUNTIME'], 'tunnelLog' | 'tunnelPid'>;
};

export interface TunnelOptions {
  config: TunnelConfig;
  spawn?: TunnelSpawn;
  onStateChange?: () => void;
  restartBaseMs?: number;
  restartMaxMs?: number;
  restartLimit?: number;
  pollIntervalMs?: number;
}
