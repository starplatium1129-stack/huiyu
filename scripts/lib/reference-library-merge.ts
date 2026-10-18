import type { Library } from './reference-store';

/** Add discovered assets without replacing curated descriptions, pending outfits or review facts. */
export function mergeReferenceLibrary(existing: Library, discovered: Library): Library {
  const result: Library = structuredClone(existing);
  function mergeById<K extends string, T extends Record<K, string>>(old: T[], incoming: T[], key: K, merge: (left: T, right: T) => T) {
    const items = new Map(old.map(item => [item[key], item]));
    for (const item of incoming) {
      const previous = items.get(item[key]);
      items.set(item[key], previous ? merge(previous, item) : structuredClone(item));
    }
    return [...items.values()];
  }
  const mergeRecord = <T extends object>(left: T, right: T): T => ({ ...structuredClone(right), ...left });
  result.standards = { ...structuredClone(discovered.standards), ...result.standards };
  result.standards.perspectives = mergeById(existing.standards.perspectives, discovered.standards.perspectives, 'id', mergeRecord);
  result.standards.characters = mergeById(existing.standards.characters, discovered.standards.characters, 'id', (left, right) => ({
    ...mergeRecord(left, right), outfits: mergeById(left.outfits, right.outfits, 'id', mergeRecord),
  }));
  for (const [id, profile] of Object.entries(discovered.view)) {
    const previous = result.view[id];
    if (!previous) { result.view[id] = structuredClone(profile); continue; }
    result.view[id] = { ...mergeRecord(previous, profile), outfits: mergeById(previous.outfits, profile.outfits, 'outfitId', (left, right) => ({
      ...mergeRecord(left, right), references: mergeById(left.references || [], right.references || [], 'id', (oldRef, newRef) => {
        const ref = mergeRecord(oldRef, newRef);
        if (oldRef.url && !Object.hasOwn(oldRef, 'pending')) delete ref.pending;
        if (!oldRef.url && oldRef.pending === true && newRef.url && newRef.pending !== true) {
          ref.url = newRef.url;
          delete ref.pending;
        }
        return ref;
      }),
    })) };
  }
  return result;
}
