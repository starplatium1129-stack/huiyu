import type { WorkspaceService } from './client';
import { createWorkspaceRouter } from '../../routes/workspace';
import { createWorkspaceSessionAuthority } from './auth';

/** The host must explicitly open and verify a workspace before mounting it. */
export function createWorkspaceGateway(options: {
  service: WorkspaceService;
  allowedOrigins: readonly string[];
}) {
  const authority = createWorkspaceSessionAuthority({
    workspaceId: options.service.workspaceId,
    runtimeEpoch: options.service.runtimeEpoch,
    allowedOrigins: options.allowedOrigins,
  });
  const router = createWorkspaceRouter(options.service, authority);
  return {
    router,
    authority,
    async close() {
      authority.close();
      await options.service.close();
    },
  };
}

export type WorkspaceGateway = ReturnType<typeof createWorkspaceGateway>;
