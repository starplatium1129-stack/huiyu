import { findStyleRecipe, KREA_STYLE_RECIPES } from '../config/kreaStyleRecipes.ts'
import { buildPopularPromptPlan, type PopularPromptOptions } from './popularPromptBuilder.ts'
import { buildStudioPromptPlan, type StudioPromptOptions } from './studioPromptBuilder.ts'
import { inferBlueprintDecisions } from './popularBlueprintDecisions.ts'
import { isManualDirectorValue } from './promptDirector.ts'
import { buildFreePromptPlan, type FreePromptOptions } from './freePromptBuilder.ts'
import { matchingRandomSetting } from './randomSceneSettings.ts'

export type PromptRecipe = (
  | ({ kind: 'popular' } & PopularPromptOptions)
  | ({ kind: 'studio' } & StudioPromptOptions)
  | ({ kind: 'free' } & FreePromptOptions)
) & { randomSetting?: boolean; kreaStyleRecipeId?: string }

/** Complete content-to-prompt entry point. Callers select inputs; they never append rendered text. */
export function compilePromptRecipe(recipe: PromptRecipe) {
  const selectedStyle = recipe.engine === 'krea2' ? findStyleRecipe(KREA_STYLE_RECIPES, recipe.kreaStyleRecipeId) : null
  if (selectedStyle) recipe = { ...recipe, style: selectedStyle }
  // Recheck the current controls on every compilation. Editing an anchor or light
  // retires its caption, and an explicit user description always owns the prose.
  if (recipe.randomSetting && !recipe.visualDescription?.trim() && !recipe.backgroundProse?.trim()) {
    const setting = matchingRandomSetting(recipe.manual ?? [], recipe.lighting)
    if (setting) recipe = { ...recipe, backgroundProse: setting.caption }
  }
  if (recipe.kind === 'studio') return buildStudioPromptPlan(recipe)
  if (recipe.kind === 'free') return {
    ...buildFreePromptPlan(recipe), profile: recipe.engine === 'moss' ? null : recipe.profile ?? null,
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
  return { ...buildPopularPromptPlan({ ...recipe, ...selections, directorSources }), selections,
    profile: recipe.engine === 'moss' ? null : recipe.profile ?? null }
}
