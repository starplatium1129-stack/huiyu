import { buildPopularPromptPlan, type PopularPromptOptions } from './popularPromptBuilder.ts'
import { buildStudioPromptPlan, type StudioPromptOptions } from './studioPromptBuilder.ts'
import { inferBlueprintDecisions } from './popularBlueprintDecisions.ts'
import { isManualDirectorValue } from './promptDirector.ts'
import { buildFreePromptPlan, type FreePromptOptions } from './freePromptBuilder.ts'

export type PromptRecipe =
  | ({ kind: 'popular' } & PopularPromptOptions)
  | ({ kind: 'studio' } & StudioPromptOptions)
  | ({ kind: 'free' } & FreePromptOptions)

/** Complete content-to-prompt entry point. Callers select inputs; they never append rendered text. */
export function compilePromptRecipe(recipe: PromptRecipe) {
  if (recipe.kind === 'studio') return buildStudioPromptPlan(recipe)
  if (recipe.kind === 'free') return {
    ...buildFreePromptPlan(recipe), profile: recipe.profile ?? null,
    selections: { shot: recipe.shot ?? null, lighting: recipe.lighting ?? null, composition: recipe.composition ?? null },
  }
  const inherited = inferBlueprintDecisions(recipe.blueprint)
  const selections = {
    shot: recipe.shot === undefined ? inherited.shot : recipe.shot,
    lighting: recipe.lighting === undefined ? inherited.lighting : recipe.lighting,
    composition: recipe.composition === undefined ? inherited.composition : recipe.composition,
  }
  const directorSources = { ...recipe.directorSources }
  for (const key of ['shot', 'lighting', 'composition'] as const) {
    directorSources[key] = isManualDirectorValue(recipe.directorSources, key, selections[key], inherited[key]) ? 'manual' : 'scene'
  }
  return { ...buildPopularPromptPlan({ ...recipe, ...selections, directorSources }), selections, profile: recipe.profile ?? null }
}
