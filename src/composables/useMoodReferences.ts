import { useShowcaseAssets } from './scene/useShowcaseAssets'

/** Reference pages share the revalidated catalogue and keep verified covers on return. */
export function useMoodReferences(enabled?: () => boolean) {
  const { entries, hasPublicScene, thumbUrl, loading, error, reload, invalidateAsset } = useShowcaseAssets(undefined, enabled)
  return { entries, thumbUrl, loading, error, reload, retryReference: invalidateAsset, referenceUrl: (id: string) => hasPublicScene(id) ? thumbUrl(id) : '' }
}
