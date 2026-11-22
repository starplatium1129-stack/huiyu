import { artworkRepository } from './artworkRepository'
import { imageMediaSession } from '../platform/imageMediaSession'
import { createDesktopStudioRepository } from '../platform/desktop/studioProjectRepository'
import { createWebStudioRepository } from '../platform/web/studioProjectRepository'
import type { StudioProjectRepository } from '../application/studio/projectRepository'
export type * from '../../types/studioProject'
export type { StudioProjectRepository, StudioAssetImport, StudioShotInitial } from '../application/studio/projectRepository'

/** Reopen the board to obtain another port after the active workspace or media authority changes. */
export function captureStudioProjectRepository(): StudioProjectRepository {
  const artwork = artworkRepository, session = imageMediaSession()
  function assertCurrent() {
    if (artwork !== artworkRepository || session !== imageMediaSession()) throw new Error('创作工作区已切换，请重新打开项目')
  }
  return artwork.getWorkspaceMediaReference ? createDesktopStudioRepository(artwork, assertCurrent) : createWebStudioRepository(assertCurrent)
}
