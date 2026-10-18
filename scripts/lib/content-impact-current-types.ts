export type Entity = Record<string, unknown> & { id: string };
export type SourceRow = { file: string; value: Entity };
export type SceneManifestEntry = Record<string, unknown> & { file: string };
export type SceneRow = SourceRow & { group: string; entry: SceneManifestEntry };
export type SceneGroup = { entry: SceneManifestEntry; files: string[]; rows: SceneRow[]; ok: boolean };
export type ImpactLevel = 'mustChange' | 'revalidate' | 'related';
export type AddImpact = (level: ImpactLevel, domain: string, object: string, reason: string) => void;
export type SceneImpact = {
  id: string;
  sourceStatus: string;
  sources: { file: string; group: string }[];
  aggregate: { file: string; status: string };
  curation: Record<string, 'included' | 'not-listed' | 'unknown'>;
  retirement: { status: string; records: Entity[] };
};
export type ThemeImpact = { id: string; file: string; canonical: boolean | null; themeStatus: string; reason: string; selector?: string };
export type OutfitDefault = { id: string; status: string; defaultOutfit: string | null; defaultIds: unknown[]; isDefaultIds: unknown[]; reasons: string[] };
type Scalar = string | number | boolean | null;
export type ShowcaseManifest = {
  file: string; status: string; reason?: string;
  entries: { index: number; id: string; type: Scalar; char: Scalar; rating: Scalar; attempt: Scalar; reviewPresent: boolean; matchedBy: string[] }[];
};
export type CurrentImpact = Parameters<typeof import('../maintenance/content-impact-references').referenceImpact>[2] & {
  version: number; readOnly: boolean;
  input: { character: string | null; outfit: string | null; scene: string | null; paths: string[] };
  mustChange: { domain: string; object: string; reason: string }[];
  revalidate: { domain: string; object: string; reason: string }[];
  related: { domain: string; object: string; reason: string }[];
  recommendations: { name: string; argv: string[]; nature: typeof import('../workflow').WORKFLOWS[string]['run']['nature']; executed: boolean }[];
  gitChanges?: ReturnType<typeof import('../maintenance/content-impact-git').collectGitChanges>;
  scenes?: SceneImpact[];
  themes?: ThemeImpact[];
  outfitDefaults?: OutfitDefault[];
  showcase?: { status: string; manifests: ShowcaseManifest[] };
};
