type RecordData = Record<string, any>;
type Library = { standards: RecordData; view: RecordData };

/** Add discovered assets without replacing curated descriptions, pending outfits or review facts. */
export function mergeReferenceLibrary(existing: Library, discovered: Library): Library {
  const result: Library = structuredClone(existing);
  function mergeById(old: any[], incoming: any[], key: string, merge: (left: any, right: any) => any) {
    const items = new Map(old.map(item => [item[key], item]));
    for (const item of incoming) items.set(item[key], items.has(item[key]) ? merge(items.get(item[key]), item) : structuredClone(item));
    return [...items.values()];
  }
  const mergeRecord = (left: any, right: any) => ({ ...structuredClone(right), ...left });
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
