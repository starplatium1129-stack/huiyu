import { useShowcaseAssets } from './scene/useShowcaseAssets'

/** Reference pages share the revalidated catalogue and keep verified covers on return. */
export function useMoodReferences() {
  const { hasPublicScene, thumbUrl, loading, error, reload, invalidateAsset } = useShowcaseAssets()
  return { loading, error, reload, retryReference: invalidateAsset, referenceUrl: (id: string) => hasPublicScene(id) ? thumbUrl(id) : '' }
}
