export type Identity = Record<string, unknown> & { id: string };
export type PopularCharacter = Identity & { outfits: Identity[] };
export type PopularRow = { id: string; outfitId: string; file: string };
export type StandardRow = { id: string; outfitIds: string[] };
export type ViewOutfit = { outfitId: string; references: Record<string, unknown>[] };
export type ViewRow = { id: string; outfits: ViewOutfit[] };
export type Selection = { character: string; outfit: string | null };
export type FileExists = (url: unknown, owner?: Pick<PopularRow, 'id' | 'outfitId'>) => boolean | null;
export type ThemeInput = { characters: Identity[]; selectors: string[]; popularAliasMap: ReadonlyMap<string, string> };
export type ReferenceInput = { popular: PopularRow[]; standards: StandardRow[]; view: ViewRow[]; fileExists: FileExists };
export type ThemeCoverage = {
  explicit: string[]; defaultAllowed: string[]; dupCharacters: string[];
  missingTheme: { id: string; accentColor: unknown; source: string }[];
  staleAlias: { selector: string; suggestion: string; matchType: string; note: string }[];
  nonCharacter: { selector: string; note: string }[];
};
export type ReferenceCoverage = {
  missingRegistration: { id: string; outfitId: string; source: string; related: string }[];
  pending: { id: string; outfitId: string; source: string; pending: number; total: number }[];
  missingImage: { id: string; outfitId: string; refId: unknown; url: unknown; source: string }[];
  unverifiedImage: { id: string; outfitId: string; refId: unknown; url: unknown }[];
  verifiedImage: number;
  referenceOnlyForms: { id: string; outfitId: string; note: string }[];
  mirrorErrors: string[]; duplicateCharacters: string[]; duplicateOutfits: string[]; duplicateRegistrations: string[];
};
export type CoverageReport = {
  version: number; structuralErrors: string[]; reference: ReferenceCoverage; themes: ThemeCoverage;
  scope?: {
    mode: string; character: string; outfit: string | null; coverageCountsScope: string;
    structuralChecksScope: string; unselectedReferenceFilesChecked: boolean;
  };
};
