const { object }: typeof import('./content-history-reader') = require('./content-history-reader');

export type ReferenceOutfit = Record<string, unknown> & { id: string; name: string; tokens?: string[]; prose?: string; isNsfw?: boolean; isDefault?: boolean };
export type ReferenceCharacter = Record<string, unknown> & { id: string; displayName: string; identityProse?: string; identityTokens?: string[]; outfits: ReferenceOutfit[] };
export type ReferencePerspective = Record<string, unknown> & { id: string; name: string };
export type ReferenceStandards = Record<string, unknown> & { characters: ReferenceCharacter[]; perspectives: ReferencePerspective[] };
export type ViewReference = Record<string, unknown> & { id: string; url?: string; pending?: boolean };
export type ReferenceViewOutfit = Record<string, unknown> & { outfitId: string; outfitName?: string; prose?: string; isNsfw?: boolean; isDefault?: boolean; references?: ViewReference[] | null };
export type ReferenceView = Record<string, Record<string, unknown> & { characterId: string; outfits: ReferenceViewOutfit[] }>;

export function readReferenceStandards(value: unknown): ReferenceStandards {
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every(item => typeof item === 'string');
  if (!object(value) || !Array.isArray(value.characters) || !Array.isArray(value.perspectives)
    || !value.perspectives.every((pers: unknown) => object(pers) && typeof pers.id === 'string' && typeof pers.name === 'string')
    || !value.characters.every((char: unknown) => object(char) && typeof char.id === 'string'
      && typeof char.displayName === 'string' && (char.identityTokens === undefined || strings(char.identityTokens))
      && (char.identityProse === undefined || typeof char.identityProse === 'string')
      && Array.isArray(char.outfits) && char.outfits.every((outfit: unknown) => object(outfit)
        && typeof outfit.id === 'string' && typeof outfit.name === 'string'
        && (outfit.tokens === undefined || strings(outfit.tokens))
        && (outfit.isNsfw === undefined || typeof outfit.isNsfw === 'boolean')
        && (outfit.isDefault === undefined || typeof outfit.isDefault === 'boolean')
        && (outfit.prose === undefined || typeof outfit.prose === 'string')))) {
    throw new Error('Invalid character reference standards');
  }
  return value as ReferenceStandards;
}

export function readReferenceView(value: unknown): ReferenceView {
  if (!object(value) || !Object.values(value).every(character => object(character)
    && typeof character.characterId === 'string' && Array.isArray(character.outfits)
    && character.outfits.every((outfit: unknown) => object(outfit) && typeof outfit.outfitId === 'string'
      && (outfit.isDefault === undefined || typeof outfit.isDefault === 'boolean')
      && (outfit.isNsfw === undefined || typeof outfit.isNsfw === 'boolean')
      && (outfit.outfitName === undefined || typeof outfit.outfitName === 'string')
      && (outfit.prose === undefined || typeof outfit.prose === 'string')
      && (outfit.references == null || (Array.isArray(outfit.references)
        && outfit.references.every((ref: unknown) => object(ref) && typeof ref.id === 'string'
          && (ref.url === undefined || typeof ref.url === 'string')
          && (ref.pending === undefined || typeof ref.pending === 'boolean'))))))) {
    throw new Error('Invalid character reference view');
  }
  return value as ReferenceView;
}
