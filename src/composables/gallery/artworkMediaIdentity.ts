import { watch, type Ref } from 'vue'
import type { ArtworkRecord } from '@/types/artwork'

type Media = Pick<ArtworkRecord, 'id' | 'image_id' | 'image_url' | 'image_data'>
/** Compare source fields directly; embedded image data is never hashed or copied. */
export function sameArtworkMedia(left: Media | undefined, right: Media | undefined): boolean {
  return Boolean(left && right && left.id === right.id && left.image_id === right.image_id
    && left.image_url === right.image_url && left.image_data === right.image_data)
}

/** Snapshot media ownership separately from mutable metadata and revoke only changed sources. */
export function watchArtworkMedia(history: Ref<ArtworkRecord[]>, invalidate: (id: string | number) => void) {
  let sources = new Map<string | number, Media>()
  watch(() => history.value.map(({ id, image_id, image_url, image_data }) => ({ id, image_id, image_url, image_data })), records => {
    const previous = sources
    sources = new Map(records.map(record => [record.id, record]))
    for (const [id, record] of previous) if (!sameArtworkMedia(record, sources.get(id))) invalidate(id)
  }, { immediate: true, flush: 'sync' })
  return (record: ArtworkRecord) => sameArtworkMedia(record, sources.get(record.id))
}
